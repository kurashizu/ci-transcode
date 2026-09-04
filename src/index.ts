import type { Env, JobRecord } from "./types";
import { json, errorResponse, bearerToken, safeEqual } from "./util";
import { dispatchTranscodeJob, fetchActiveRunIds } from "./github";
import { presignGet, presignPut } from "./r2sign";
import { API_DOCS_MARKDOWN, renderDocsHtml } from "./docs";
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
      if (pathname === "/docs.md") {
        return new Response(API_DOCS_MARKDOWN, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }

      if (pathname === "/" || pathname === "/docs") {
        // Markdown by default -- this endpoint mainly serves curl/agents, which send
        // Accept: */* rather than asking for HTML. Only requests that explicitly prefer
        // text/html (i.e. browsers) get the rendered page.
        const accept = request.headers.get("accept") ?? "";
        const wantsHtml = accept.includes("text/html");
        if (wantsHtml) {
          return new Response(renderDocsHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(API_DOCS_MARKDOWN, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
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
        return handleInternalCallback(request, env, ctx);
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
        return handleInternalSweep(request, env, ctx);
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
  // blocks this request's response. Any queued job the sweep promotes still needs its GitHub
  // dispatch actually fired (the DO never calls out to GitHub itself).
  ctx.waitUntil(
    callDO(env, "/sweep", {})
      .then(async (res) => {
        const data: any = await res.json();
        for (const jobId of data?.promotedJobIds ?? []) {
          fireDispatch(jobId, request.url, env, ctx);
        }
      })
      .catch(() => {}),
  );

  const doRes = await callDO(env, "/create", body);
  return doRes;
}

/**
 * Actually fires the GitHub repository_dispatch for a job the DO has already marked
 * "dispatching" (whether from a fresh commit or a queue promotion). The DO itself never makes
 * outbound calls to GitHub -- every path that transitions a job into "dispatching" MUST route
 * through this function, or that job will sit dispatching forever with no CI run behind it.
 */
function fireDispatch(jobId: string, requestUrl: string, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    (async () => {
      const callbackUrl = new URL(requestUrl);
      callbackUrl.pathname = "/internal/callback";
      callbackUrl.search = "";

      try {
        const jobRes = await callDO(env, `/job/${jobId}`);
        const jobData: any = await jobRes.json();
        const job: JobRecord | undefined = jobData?.job;
        // No record found for a job the DO just told us to dispatch shouldn't happen, but if it
        // does, don't silently strand the slot -- surface it the same as any other dispatch
        // failure so the job (if it still exists under a different read) gets marked failed and
        // the sweep's stall-timeout reconciliation can eventually recover the slot regardless.
        if (!job) throw new Error("job record not found immediately after promotion/commit");

        await dispatchTranscodeJob(env, job, callbackUrl.toString());
      } catch (err: any) {
        // Every failure path here -- DO lookup, JSON parsing, or the dispatch call itself -- must
        // still report "failed" back to the DO. Silently returning would leave the job stuck in
        // "dispatching" forever with its concurrency slot never released (short of the 6h stall
        // timeout). This callback call can itself fail (network blip, DO hiccup); that's fine --
        // the stall timeout is the final backstop for that residual case.
        await callDO(env, "/callback", {
          jobId,
          status: "failed",
          error: `dispatch failed: ${err?.message ?? err}`,
        }).catch(() => {});
      }
    })(),
  );
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
    fireDispatch(jobId, request.url, env, ctx);
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

async function handleInternalCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json();
  const doRes = await callDO(env, "/callback", body);
  const data: any = await doRes.clone().json();

  if (data?.promotedJobId) {
    fireDispatch(data.promotedJobId, request.url, env, ctx);
  }

  return doRes;
}

/** CI asks the Worker for a short-lived presigned GET to download the source it must transcode. */
async function handleInternalSourceUrl(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const { sourceKey } = await request.json<{ sourceKey: string }>();
  if (!sourceKey) return errorResponse(400, "missing sourceKey");
  // Even with a valid internal secret, only ever sign keys under the prefix this endpoint owns --
  // caps the blast radius of a leaked secret to source objects, not the whole bucket.
  if (!/^sources\/[a-f0-9]+\/[a-f0-9]+\.bin$/.test(sourceKey)) {
    return errorResponse(400, "invalid sourceKey");
  }

  const url = await presignGet(env, sourceKey, Number(env.UPLOAD_URL_TTL_SECONDS));
  return json({ url });
}

/** CI asks the Worker for a short-lived presigned PUT to upload the transcoded result. */
async function handleInternalResultUrl(request: Request, env: Env): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  const { resultKey } = await request.json<{ resultKey: string }>();
  if (!resultKey) return errorResponse(400, "missing resultKey");
  if (!/^results\/[a-f0-9]+\/[a-f0-9]+\.av1\.mp4$/.test(resultKey)) {
    return errorResponse(400, "invalid resultKey");
  }

  const url = await presignPut(env, resultKey, Number(env.UPLOAD_URL_TTL_SECONDS));
  return json({ url });
}

async function handleInternalSweep(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authErr = requireInternalAuth(request, env);
  if (authErr) return authErr;

  // Cross-check against GitHub's real queued/in_progress run ids -- this is what catches jobs
  // orphaned by an out-of-band cancellation or a vanished runner (see handleSweep's docs). Best
  // effort: a failed/timed-out GitHub query just skips that reconciliation for this pass rather
  // than blocking the sweep, since TTL/stall-timeout sweeping must still work during a GitHub
  // outage.
  const activeRunIds = await fetchActiveRunIds(env);

  const doRes = await callDO(env, "/sweep", {
    activeRunIds: activeRunIds ? [...activeRunIds] : undefined,
  });
  const data: any = await doRes.clone().json();

  for (const jobId of data?.promotedJobIds ?? []) {
    fireDispatch(jobId, request.url, env, ctx);
  }

  return doRes;
}
