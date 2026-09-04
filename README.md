# ci-transcode

Asynchronous AV1 software transcoding service built on Cloudflare Workers + Durable Objects + R2 + GitHub Actions.

- Transcode engine: ffmpeg (libsvtav1), configurable `crf` (default 40) and `preset` (0-13 numeric SVT-AV1 preset, default 4)
- Concurrency: up to 10 parallel transcode jobs (atomically enforced by a Durable Object)
- Storage: Cloudflare R2, 5GB quota, LRU eviction when full, 1-day TTL per job by default
- Privacy-first: the R2 bucket is private (all access via presigned URLs), CI never logs or emits any video filename or metadata
- API docs: visit the Worker's root path `/` after deployment

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
  accessing that job, returned only once at creation time.
- R2 object keys are random IDs; they never contain the original filename. The bucket itself
  has no public network access.
- CI exchanges its internal secret for short-lived, single-purpose presigned URLs via
  `/internal/*` endpoints to read/write R2 — R2's long-lived credentials (Access Key/Secret)
  never touch the CI environment.
- ffmpeg runs with `-loglevel error -nostats` and its stdout/stderr are discarded — never
  written to disk, uploaded, or logged. Only the process exit code determines success/failure.
- The source file is deleted immediately once a job terminates (success or failure). Result
  files expire after 1 day by default via TTL, and the oldest-accessed objects are evicted
  first once storage exceeds quota.
