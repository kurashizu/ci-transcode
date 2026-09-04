import type { Env, JobRecord, JobStatus } from "../types";
import { randomId, randomToken } from "../util";
import { presignGet, presignPut } from "../r2sign";

const JOB_PREFIX = "job:";
const ACTIVE_COUNT_KEY = "meta:active_count";
const LRU_INDEX_KEY = "meta:lru_index"; // array of jobId ordered oldest-touched-first
const USAGE_KEY = "meta:usage_bytes"; // approximate total bytes tracked in R2 for this system

interface LruEntry {
  jobId: string;
  lastTouched: number;
}

/**
 * Single global Durable Object instance (id derived from a fixed name) acting as the
 * strongly-consistent coordinator for job state, CI concurrency (max 10 parallel),
 * and R2 quota bookkeeping (5 GiB, LRU eviction + 1 day TTL).
 */
export class JobRegistry {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/create" && request.method === "POST") {
        return await this.handleCreate(request);
      }
      if (path === "/commit" && request.method === "POST") {
        return await this.handleCommit(request);
      }
      if (path.startsWith("/job/") && request.method === "GET") {
        return await this.handleGet(path.slice("/job/".length));
      }
      if (path === "/callback" && request.method === "POST") {
        return await this.handleCallback(request);
      }
      if (path === "/result" && request.method === "POST") {
        return await this.handleResultUrl(request);
      }
      if (path === "/sweep" && request.method === "POST") {
        return await this.handleSweep();
      }
      return new Response("not found", { status: 404 });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err?.message ?? "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ---- helpers ----

  private async getActiveCount(): Promise<number> {
    return (await this.state.storage.get<number>(ACTIVE_COUNT_KEY)) ?? 0;
  }

  private async setActiveCount(n: number): Promise<void> {
    await this.state.storage.put(ACTIVE_COUNT_KEY, n);
  }

  private async getUsage(): Promise<number> {
    return (await this.state.storage.get<number>(USAGE_KEY)) ?? 0;
  }

  private async setUsage(n: number): Promise<void> {
    await this.state.storage.put(USAGE_KEY, Math.max(0, n));
  }

  private async getLru(): Promise<LruEntry[]> {
    return (await this.state.storage.get<LruEntry[]>(LRU_INDEX_KEY)) ?? [];
  }

  private async setLru(entries: LruEntry[]): Promise<void> {
    await this.state.storage.put(LRU_INDEX_KEY, entries);
  }

  private async touchLru(jobId: string): Promise<void> {
    const list = await this.getLru();
    const filtered = list.filter((e) => e.jobId !== jobId);
    filtered.push({ jobId, lastTouched: Date.now() });
    await this.setLru(filtered);
  }

  private async removeLru(jobId: string): Promise<void> {
    const list = await this.getLru();
    await this.setLru(list.filter((e) => e.jobId !== jobId));
  }

  private async getJob(jobId: string): Promise<JobRecord | null> {
    return (await this.state.storage.get<JobRecord>(JOB_PREFIX + jobId)) ?? null;
  }

  private async putJob(job: JobRecord): Promise<void> {
    job.updatedAt = Date.now();
    await this.state.storage.put(JOB_PREFIX + jobId(job), job);
  }

  // ---- handlers ----

  /** Step 1: allocate a job, source/result keys, and a presigned PUT URL for the source upload. */
  private async handleCreate(request: Request): Promise<Response> {
    const body = await request.json<{ crf?: number; preset?: number }>();
    const crf = clampCrf(body.crf, Number(this.env.DEFAULT_CRF));
    const preset = clampPreset(body.preset, Number(this.env.DEFAULT_PRESET));

    const jobId = randomId(12);
    const token = randomToken();
    const now = Date.now();
    const ttlMs = Number(this.env.JOB_TTL_SECONDS) * 1000;

    const job: JobRecord = {
      jobId,
      token,
      status: "awaiting_upload",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      sourceKey: `sources/${jobId}/${randomId(8)}.bin`,
      resultKey: `results/${jobId}/${randomId(8)}.av1.mp4`,
      sourceBytes: null,
      resultBytes: null,
      crf,
      preset,
      error: null,
      ciRunHint: null,
    };

    await this.state.storage.put(JOB_PREFIX + jobId, job);
    await this.touchLru(jobId);

    const uploadUrl = await presignPut(
      this.env,
      job.sourceKey,
      Number(this.env.UPLOAD_URL_TTL_SECONDS),
    );

    return respond({
      jobId,
      token,
      uploadUrl,
      uploadMethod: "PUT",
      expiresAt: new Date(job.expiresAt).toISOString(),
      crf: job.crf,
      preset: job.preset,
    });
  }

  /** Step 2: user confirms upload finished; verify object exists, check quota/LRU, enqueue + dispatch CI. */
  private async handleCommit(request: Request): Promise<Response> {
    const { jobId, token } = await request.json<{ jobId: string; token: string }>();
    const job = await this.requireAuth(jobId, token);
    if (job instanceof Response) return job;

    if (job.status !== "awaiting_upload") {
      return respond({ error: `job is not awaiting upload (status=${job.status})` }, 409);
    }

    const head = await this.env.BUCKET.head(job.sourceKey);
    if (!head) {
      return respond({ error: "source object not found in R2; upload may have failed" }, 400);
    }
    const maxBytes = Number(this.env.MAX_UPLOAD_BYTES);
    if (head.size > maxBytes) {
      await this.env.BUCKET.delete(job.sourceKey);
      return respond({ error: `source exceeds max allowed size (${maxBytes} bytes)` }, 413);
    }

    job.sourceBytes = head.size;
    await this.reserveQuota(head.size);
    await this.touchLru(jobId);

    const activeCount = await this.getActiveCount();
    const maxParallel = Number(this.env.MAX_PARALLEL_JOBS);

    if (activeCount >= maxParallel) {
      job.status = "queued";
      await this.putJobRaw(job);
      return respond({ status: job.status, queued: true });
    }

    await this.setActiveCount(activeCount + 1);
    job.status = "dispatching";
    await this.putJobRaw(job);

    // fire-and-forget: dispatch happens from the Worker (has fetch to github.com); here we just
    // mark state. The actual GitHub API call is made by the caller (index.ts) after commit returns,
    // to keep this DO free of outbound-fetch coupling to GitHub's API shape.
    return respond({ status: job.status, queued: false, dispatchNow: true });
  }

  private async handleGet(jobId: string): Promise<Response> {
    const job = await this.getJob(jobId);
    if (!job) return respond({ error: "not found" }, 404);
    return respond({ job });
  }

  /** Called by the Worker's auth layer after validating the bearer token, to fetch the raw job (internal use). */
  private async putJobRaw(job: JobRecord): Promise<void> {
    job.updatedAt = Date.now();
    await this.state.storage.put(JOB_PREFIX + job.jobId, job);
  }

  private async requireAuth(jobId: string, token: string): Promise<JobRecord | Response> {
    if (!jobId || !token) return respond({ error: "missing jobId or token" }, 400);
    const job = await this.getJob(jobId);
    if (!job) return respond({ error: "not found" }, 404);
    if (job.token !== token) return respond({ error: "unauthorized" }, 403);
    if (job.expiresAt < Date.now()) return respond({ error: "job expired" }, 410);
    return job;
  }

  /** CI -> Worker -> DO status callback, authenticated separately via INTERNAL_CALLBACK_SECRET in the Worker. */
  private async handleCallback(request: Request): Promise<Response> {
    const body = await request.json<{
      jobId: string;
      status: JobStatus;
      error?: string;
      resultBytes?: number;
    }>();
    const job = await this.getJob(body.jobId);
    if (!job) return respond({ error: "not found" }, 404);

    job.status = body.status;
    if (body.error) job.error = body.error;
    if (typeof body.resultBytes === "number") job.resultBytes = body.resultBytes;
    await this.touchLru(job.jobId);

    let promotedJobId: string | null = null;

    if (body.status === "done" || body.status === "failed") {
      const active = await this.getActiveCount();
      await this.setActiveCount(Math.max(0, active - 1));

      // source is no longer needed regardless of outcome; free it immediately.
      await this.env.BUCKET.delete(job.sourceKey).catch(() => {});
      if (job.sourceBytes) await this.reserveQuota(-job.sourceBytes);

      if (body.status === "done" && typeof body.resultBytes === "number") {
        await this.reserveQuota(body.resultBytes);
      }

      const promoted = await this.promoteNextQueued();
      promotedJobId = promoted?.jobId ?? null;
    }

    await this.putJobRaw(job);
    // The DO never makes outbound HTTP calls to GitHub itself (that stays in the Worker, same
    // as the initial commit flow) -- so if a queued job was just promoted to "dispatching" here,
    // the caller (Worker) MUST actually fire the GitHub dispatch for promotedJobId, or that job
    // will sit in "dispatching" forever with no CI run ever triggered.
    return respond({ ok: true, promotedJobId });
  }

  /** Issue a presigned GET for the finished result, only once status === done. */
  private async handleResultUrl(request: Request): Promise<Response> {
    const { jobId, token } = await request.json<{ jobId: string; token: string }>();
    const job = await this.requireAuth(jobId, token);
    if (job instanceof Response) return job;

    if (job.status !== "done") {
      return respond({ error: `result not ready (status=${job.status})` }, 409);
    }

    const url = await presignGet(this.env, job.resultKey, Number(this.env.RESULT_URL_TTL_SECONDS));
    return respond({ resultUrl: url, expiresIn: Number(this.env.RESULT_URL_TTL_SECONDS) });
  }

  /** Pull the next queued job (oldest first) into an active dispatch slot, if capacity allows. */
  private async promoteNextQueued(): Promise<{ jobId: string } | null> {
    const maxParallel = Number(this.env.MAX_PARALLEL_JOBS);
    const active = await this.getActiveCount();
    if (active >= maxParallel) return null;

    const all = await this.state.storage.list<JobRecord>({ prefix: JOB_PREFIX });
    let oldestQueued: JobRecord | null = null;
    for (const job of all.values()) {
      if (job.status === "queued") {
        if (!oldestQueued || job.createdAt < oldestQueued.createdAt) oldestQueued = job;
      }
    }
    if (!oldestQueued) return null;

    oldestQueued.status = "dispatching";
    await this.putJobRaw(oldestQueued);
    await this.setActiveCount(active + 1);
    return { jobId: oldestQueued.jobId };
  }

  /** Quota reservation: never blocks — evicts LRU entries first if projected usage would exceed quota. */
  private async reserveQuota(deltaBytes: number): Promise<void> {
    const quota = Number(this.env.R2_QUOTA_BYTES);
    let usage = await this.getUsage();
    usage += deltaBytes;

    if (usage > quota) {
      const toFree = usage - quota;
      const freed = await this.evictLru(toFree);
      usage -= freed;
    }
    await this.setUsage(usage);
  }

  /**
   * LRU eviction: walk the touch-order index oldest-first, deleting terminal jobs' R2 objects
   * (results of done/failed/expired jobs) until enough bytes are freed. Never evicts a job that's
   * still in flight (awaiting_upload/queued/dispatching/downloading/transcoding/uploading).
   */
  private async evictLru(bytesNeeded: number): Promise<number> {
    const lru = await this.getLru();
    let freed = 0;
    const survivors: LruEntry[] = [];

    for (const entry of lru) {
      if (freed >= bytesNeeded) {
        survivors.push(entry);
        continue;
      }
      const job = await this.getJob(entry.jobId);
      if (!job) continue; // already gone

      const terminal = job.status === "done" || job.status === "failed" || job.status === "expired";
      if (!terminal) {
        survivors.push(entry);
        continue;
      }

      let freedHere = 0;
      if (job.status === "done" && job.resultBytes) {
        await this.env.BUCKET.delete(job.resultKey).catch(() => {});
        freedHere += job.resultBytes;
      }
      job.status = "expired";
      job.error = job.error ?? "evicted: storage quota reached (LRU)";
      await this.putJobRaw(job);
      freed += freedHere;
      // entry dropped from survivors -> removed from LRU index
    }

    await this.setLru(survivors);
    return freed;
  }

  /** Periodic sweep (invoked by the Worker's cron trigger): expire stale jobs past TTL, free R2,
   * and reclaim concurrency slots leaked by jobs whose CI callback was lost (GitHub/Worker outage,
   * a runner that died without reaching its `if: failure()` step, etc). */
  private async handleSweep(): Promise<Response> {
    const now = Date.now();
    const all = await this.state.storage.list<JobRecord>({ prefix: JOB_PREFIX });
    let expiredCount = 0;
    let freedBytes = 0;
    let reclaimedSlots = 0;

    const stallTimeoutMs = Number(this.env.STALL_TIMEOUT_SECONDS) * 1000;
    const activeCiStates: JobStatus[] = ["dispatching", "downloading", "transcoding", "uploading"];

    for (const job of all.values()) {
      if (activeCiStates.includes(job.status) && now - job.updatedAt > stallTimeoutMs) {
        job.status = "failed";
        job.error = "stalled: no status update received for longer than STALL_TIMEOUT_SECONDS " +
          "(likely a lost CI callback -- GitHub/network outage or a runner that died silently)";
        await this.env.BUCKET.delete(job.sourceKey).catch(() => {});
        if (job.sourceBytes) freedBytes += job.sourceBytes;
        await this.putJobRaw(job);

        const active = await this.getActiveCount();
        await this.setActiveCount(Math.max(0, active - 1));
        reclaimedSlots++;
        await this.promoteNextQueued();
        continue;
      }

      if (job.expiresAt >= now) continue;
      if (job.status === "expired") continue;

      if (job.sourceKey && (job.status === "awaiting_upload" || job.status === "queued")) {
        await this.env.BUCKET.delete(job.sourceKey).catch(() => {});
        if (job.sourceBytes) freedBytes += job.sourceBytes;
      }
      if (job.resultKey && job.status === "done" && job.resultBytes) {
        await this.env.BUCKET.delete(job.resultKey).catch(() => {});
        freedBytes += job.resultBytes;
      }

      job.status = "expired";
      job.error = job.error ?? "expired (TTL reached)";
      await this.putJobRaw(job);
      await this.removeLru(job.jobId);
      expiredCount++;
    }

    if (freedBytes > 0) await this.reserveQuota(-freedBytes);

    // Reconcile activeCount against reality instead of trusting the incrementally-maintained
    // counter: anything that bypasses our callback path (a run cancelled directly on GitHub, a
    // runner killed out-of-band, a lost message) can desync the counter from the true number of
    // jobs actually occupying a slot. Recomputing it here, and promoting queued jobs into any
    // slots that reconciliation frees up, makes the queue self-healing rather than requiring the
    // 6h stall timeout to eventually notice.
    const afterSweep = await this.state.storage.list<JobRecord>({ prefix: JOB_PREFIX });
    const activeCiStatesForCount: JobStatus[] = ["dispatching", "downloading", "transcoding", "uploading"];
    let trueActiveCount = 0;
    for (const job of afterSweep.values()) {
      if (activeCiStatesForCount.includes(job.status)) trueActiveCount++;
    }
    const previousActiveCount = await this.getActiveCount();
    if (previousActiveCount !== trueActiveCount) {
      await this.setActiveCount(trueActiveCount);
    }

    const promotedJobIds: string[] = [];
    const maxParallel = Number(this.env.MAX_PARALLEL_JOBS);
    while ((await this.getActiveCount()) < maxParallel) {
      const promoted = await this.promoteNextQueued();
      if (!promoted) break;
      promotedJobIds.push(promoted.jobId);
    }

    return respond({
      expiredCount,
      freedBytes,
      reclaimedSlots,
      trueActiveCount,
      // Same contract as /callback's promotedJobId: the caller MUST fire a real GitHub dispatch
      // for each of these, or they'll sit in "dispatching" forever with no CI run behind them.
      promotedJobIds,
    });
  }
}

function jobId(job: JobRecord): string {
  return job.jobId;
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clampCrf(input: unknown, fallback: number): number {
  const n = typeof input === "number" ? input : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(63, Math.max(0, Math.round(n)));
}

function clampPreset(input: unknown, fallback: number): number {
  const n = typeof input === "number" ? input : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(13, Math.max(0, Math.round(n)));
}
