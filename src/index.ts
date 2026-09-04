import type { Env, JobRecord } from "./types";
import { json, errorResponse, bearerToken, safeEqual } from "./util";
import { dispatchTranscodeJob } from "./github";
import { presignGet, presignPut } from "./r2sign";
import { API_DOCS_HTML } from "./docs";
export { JobRegistry } from "./durable-objects/job-registry";

function registryStub(env: Env): DurableObjectStub {
  const id = env.JOB_REGISTRY.idFromName("global");
  return env.JOB_REGISTRY.get(id);
}

function callDO(env: Env, path: string, body?: unknown): Promise<Response> {
  return registryStub(env).fetch(`https://do/${path.replace(/^\//, "")}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/" || pathname === "/docs") {
        return new Response(API_DOCS_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/jobs" && request.method === "POST") {
        return handleCreateJob(request, env, ctx);
      }

      const commitMatch = pathname.match(/^\/jobs\/([a-f0-9]+)\/commit$/);
      if (commitMatch && request.method === "POST") {
        return handleCommitJob(commitMatch[1], request, env, ctx);
      }

      const resultMatch = pathname.match(/^\/jobs\/([a-f0-9]+)\/result$/);
      if (resultMatch && request.method === "GET") {
        return handleResult(resultMatch[1], request, env);
      }

      const jobMatch = pathname.match(/^\/jobs\/([a-f0-9]+)$/);
      if (jobMatch && request.method === "GET") {
        return handleGetJob(jobMatch[1], request, env);
      }

      if (pathname === "/internal/callback" && request.method === "POST") {
        return handleInternalCallback(request, env);
      }

      if (pathname === "/internal/source-url" && request.method === "POST") {
        return handleInternalSourceUrl(request, env);
      }

      if (pathname === "/internal/result-url" && request.method === "POST") {
        return handleInternalResultUrl(request, env);
      }

      // Free-plan accounts have a low account-wide cron trigger limit, so TTL/LRU sweeping is
      // triggered lazily instead of via a Workers Cron Trigger: opportunistically on job creation
      // (fire-and-forget, never blocks the response) and explicitly via this authenticated endpoint
      // for external schedulers (e.g. a GitHub Actions cron, or any uptime-ping style caller).
      if (pathname === "/internal/sweep" && request.method === "POST") {
        return handleInternalSweep(request, env);
      }

      return errorResponse(404, "not found");
    } catch (err: any) {
      return errorResponse(500, err?.message ?? "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function handleCreateJob(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: { crf?: number; preset?: string } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine, defaults apply
  }

  // Opportunistic lazy sweep: cheap (single DO round trip, no-op if nothing expired) and never
  // blocks this request's response.
  ctx.waitUntil(callDO(env, "/sweep", {}).catch(() => {}));

  const doRes = await callDO(env, "/create", body);
  return doRes;
}

async function handleCommitJob(
  jobId: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return errorResponse(401, "missing bearer token");

  const doRes = await callDO(env, "/commit", { jobId, token });
  const data: any = await doRes.json();
  if (!doRes.ok) return json(data, { status: doRes.status });

  if (data.dispatchNow) {
    // Fetch the job record so we can build the dispatch payload; do this via the DO's /job/:id.
    const jobRes = await callDO(env, `/job/${jobId}`);
    const jobData: any = await jobRes.json();
    const job: JobRecord | undefined = jobData?.job;

    if (job) {
      const callbackUrl = new URL(request.url);
      callbackUrl.pathname = "/internal/callback";
      callbackUrl.search = "";

      ctx.waitUntil(
        dispatchTranscodeJob(env, job, callbackUrl.toString()).catch(async (err) => {
          await callDO(env, "/callback", {
            jobId,
            status: "failed",
            error: `dispatch failed: ${err?.message ?? err}`,
          });
        }),
      );
    }
  }

  return json({ jobId, status: data.status, queued: !!data.queued });
}

async function handleGetJob(jobId: string, request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return errorResponse(401, "missing bearer token");

  const doRes = await callDO(env, `/job/${jobId}`);
  const data: any = await doRes.json();
  if (!doRes.ok) return json(data, { status: doRes.status });

  const job: JobRecord = data.job;
  if (!safeEqual(job.token, token)) return errorResponse(403, "unauthorized");

  return json({
    jobId: job.jobId,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    expiresAt: new Date(job.expiresAt).toISOString(),
    sourceBytes: job.sourceBytes,
    resultBytes: job.resultBytes,
    crf: job.crf,
    preset: job.preset,
    error: job.error,
  });
}

async function handleResult(jobId: string, request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return errorResponse(401, "missing bearer token");

  const doRes = await callDO(env, "/result", { jobId, token });
  const data: any = await doRes.json();
  return json(data, { status: doRes.status });
}

// ---------------------------------------------------------------------------
// Internal API (CI-only, authenticated via INTERNAL_CALLBACK_SECRET)
// ---------------------------------------------------------------------------

function requireInternalAuth(request: Request, env: Env): Response | null {
  const token = bearerToken(request);
  if (!token || !safeEqual(token, env.INTERNAL_CALLBACK_SECRET)) {
    return errorResponse(401, "unauthorized");
  }
  return null;
}

async function handleInternalCallback(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json();
  const doRes = await callDO(env, "/callback", body);
  return doRes;
}

/** CI asks the Worker for a short-lived presigned GET to download the source it must transcode. */
async function handleInternalSourceUrl(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const { sourceKey } = await request.json<{ sourceKey: string }>();
  if (!sourceKey) return errorResponse(400, "missing sourceKey");

  const url = await presignGet(env, sourceKey, Number(env.UPLOAD_URL_TTL_SECONDS));
  return json({ url });
}

/** CI asks the Worker for a short-lived presigned PUT to upload the transcoded result. */
async function handleInternalResultUrl(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const { resultKey } = await request.json<{ resultKey: string }>();
  if (!resultKey) return errorResponse(400, "missing resultKey");

  const url = await presignPut(env, resultKey, Number(env.UPLOAD_URL_TTL_SECONDS));
  return json({ url });
}

async function handleInternalSweep(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const doRes = await callDO(env, "/sweep", {});
  return doRes;
}
