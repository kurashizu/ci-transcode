# ci-transcode

Asynchronous AV1 software transcoding service built on Cloudflare Workers + Durable Objects + R2 + GitHub Actions.

- Transcode engine: ffmpeg (libsvtav1), configurable `crf` (default 40) and `preset` (0-13 numeric SVT-AV1 preset, default 4)
- Output: AV1 + Opus in an MP4 container (not Matroska — maximizes player compatibility)
- Concurrency: up to 10 parallel transcode jobs, enforced by a Durable Object; queued jobs are promoted the moment a slot frees up, and that promotion always fires a real GitHub dispatch (not just an internal status flip)
- Storage: Cloudflare R2, 5GB quota, LRU eviction when full, 1-day TTL per job by default; expired job records are deleted outright, not just flagged, so the coordinator's state doesn't grow without bound
- Self-healing: a periodic sweep reconciles the concurrency counter against jobs' actual state (recovers from an out-of-band GitHub Actions cancellation, a lost callback, etc.) and marks anything stalled in an active CI stage for 6+ hours as failed, freeing its slot
- Privacy-first: the R2 bucket is private (all access via presigned URLs), CI never logs or emits any video filename or metadata — a failed job's error names only which pipeline step failed
- API docs: visit the Worker's root path `/` after deployment (serves Markdown to curl/agents by default, HTML to browsers)

## Project layout

```
src/
  index.ts                    Worker entrypoint, routing and REST API
  docs.ts                     API docs page (HTML, served at / and /docs)
  types.ts                    Shared type definitions
  util.ts                     Random id/token generation, auth helpers
  r2sign.ts                   R2 (S3-compatible) presigned URL generation
  github.ts                   repository_dispatch call wrapper
  durable-objects/
    job-registry.ts           Global coordinator: job state, concurrency slots, LRU/TTL eviction
.github/workflows/
  transcode.yml                CI: download source -> ffmpeg transcode -> upload result -> report status
scripts/
  e2e.sh                       End-to-end smoke test script
```

## Deployment

### 1. Create the R2 bucket

```bash
wrangler r2 bucket create ci-transcode-store
```

### 2. Create an R2 API Token (S3-compatible credentials, used for presigning)

Cloudflare Dashboard → R2 → Manage R2 API Tokens → create a token with read/write access to
the bucket above. Record the **Account ID**, **Access Key ID**, and **Secret Access Key**.

### 3. Set up the GitHub repository

This repository doubles as the CI-side repo (it contains `.github/workflows/transcode.yml`).
Under Settings → Secrets and variables → Actions, add:

| Secret/Variable | Description |
|---|---|
| `INTERNAL_CALLBACK_SECRET` (secret) | Shared secret matching the Worker's copy; CI uses it to authenticate callback/presign requests |
| `WORKER_BASE_URL` (variable) | The deployed Worker's origin, e.g. `https://ci-transcode.xxx.workers.dev` |

### 4. Create a GitHub PAT (for the Worker to trigger repository_dispatch)

A fine-grained PAT scoped to this repository's `Contents: Read and write` permission
(repository_dispatch requires the equivalent of `contents: write`).

### 5. Configure Worker secrets

Only genuinely sensitive credentials are stored as secrets; non-sensitive configuration
(GitHub owner/repo, R2 account id, bucket name) lives as plain `[vars]` in `wrangler.toml`
and is committed with the source — edit it directly as needed.

```bash
wrangler secret put GITHUB_TOKEN             # PAT from step 4
wrangler secret put INTERNAL_CALLBACK_SECRET # same random string as step 3
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

### 6. Deploy

```bash
npm install
npm run deploy
```

## End-to-end test

```bash
BASE_URL=https://ci-transcode.<subdomain>.workers.dev ./scripts/e2e.sh
```

The script creates a job, generates a 2-second test clip and PUTs it to the presigned upload
URL, commits the job to trigger CI, polls status until `done`/`failed`, then downloads the
transcoded result and confirms it exists.

## API overview

See the `GET /` page after deployment, or read `src/docs.ts` directly. Core flow:

```
POST /jobs                    -> { jobId, token, uploadUrl }
PUT  <uploadUrl>               (direct upload to R2)
POST /jobs/{id}/commit         (Bearer token, triggers CI)
GET  /jobs/{id}                (Bearer token, poll status)
GET  /jobs/{id}/result          (Bearer token, presigned download URL once done)
```

## Security design notes

- Each job's `token` is generated from 32 bytes of CSPRNG output — the sole credential for
  accessing that job, returned only once at creation time. All token comparisons use a
  constant-time equality check.
- R2 object keys are random IDs; they never contain the original filename. The bucket itself
  has no public network access.
- CI exchanges its internal secret for short-lived, single-purpose presigned URLs via
  `/internal/*` endpoints to read/write R2 — R2's long-lived credentials (Access Key/Secret)
  never touch the CI environment. Those endpoints validate that the requested key matches this
  service's own `sources/<id>/<id>.bin` / `results/<id>/<id>.av1.mp4` shape before signing
  anything, so a leaked internal secret can't be used to sign arbitrary bucket paths.
- ffmpeg runs with `-loglevel error -nostats` and its stdout/stderr are discarded — never
  written to disk, uploaded, or logged. Only the process exit code determines success/failure;
  a failed job's `error` field names which pipeline step failed (e.g. "download", "transcode"),
  never any file content.
- The source file is deleted immediately once a job terminates (success or failure). Result
  files expire after 1 day by default via TTL, and the oldest-accessed objects are evicted
  first once storage exceeds quota. Expired/evicted job records are deleted, not just flagged.
- Every callback CI sends to the Worker, and the Worker's own dispatch call to GitHub, has an
  explicit timeout (and CI's callbacks retry a few times) — a GitHub or network outage fails
  fast instead of hanging a runner or silently stranding a job's concurrency slot. A sweep pass
  also reconciles the concurrency counter against jobs' real state and force-fails anything
  stuck in an active CI stage for more than 6 hours (`STALL_TIMEOUT_SECONDS`), so an out-of-band
  cancellation or a lost callback can't leak a slot indefinitely.
- Every CI callback also carries `$GITHUB_RUN_ID`, recorded on the job as `ciRunHint`. The sweep
  cross-checks each active job's specific run id against GitHub's real queued/in-progress runs
  (via the GitHub API) and fails only the ones whose exact run is provably gone — this is a
  precise, per-record fact check, never a guess from aggregate counts. (An earlier version
  compared DO active-record counts against GitHub's real run count and killed the
  oldest-`updatedAt` records to make the totals match; that shipped once and force-failed
  genuinely running jobs, because a job mid-transcode can go untouched for many minutes between
  callbacks. Do not reintroduce that pattern — see the comment above `handleSweep`'s orphan
  detection in `job-registry.ts`.)
- Source uploads are capped at 2 GiB (`MAX_UPLOAD_BYTES`), enforced after upload via an R2 `HEAD`
  on commit; an oversized object is deleted and the commit rejected.
- Before running ffmpeg, CI probes the real source (duration/resolution via `ffprobe`) and
  estimates its own transcode time from an empirical preset/resolution model, calibrated against
  one real run on GitHub's standard 2 vCPU runner. If the estimate exceeds `MAX_ESTIMATED_CI_SECONDS`
  (3h default), CI aborts before transcoding rather than occupying a runner for hours on a config
  that was never going to finish. None of the probed values are ever logged or reported back —
  only the pass/fail decision crosses out of that step.
