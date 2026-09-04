import type { Env, JobRecord } from "./types";

/**
 * Triggers the transcode workflow via repository_dispatch. The payload intentionally carries
 * only opaque identifiers (jobId, R2 object keys, crf/preset, and a callback URL/secret) —
 * never the original filename or any user-supplied metadata.
 */
const DISPATCH_TIMEOUT_MS = 15_000;

export async function dispatchTranscodeJob(
  env: Env,
  job: JobRecord,
  callbackUrl: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`;

  // GitHub being slow or unresponsive must not leave a job (and its concurrency slot) stuck in
  // "dispatching" forever -- an explicit timeout guarantees this call always settles, so the
  // caller's .catch() can mark the job failed and release the slot.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ci-transcode-worker",
      },
      body: JSON.stringify({
        event_type: "transcode",
        client_payload: {
          job_id: job.jobId,
          source_key: job.sourceKey,
          result_key: job.resultKey,
          crf: job.crf,
          preset: job.preset,
          callback_url: callbackUrl,
          max_estimated_ci_seconds: Number(env.MAX_ESTIMATED_CI_SECONDS),
        },
      }),
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`github dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`);
    }
    throw new Error(`github dispatch network error: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github dispatch failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

const RUNS_QUERY_TIMEOUT_MS = 10_000;

/**
 * Fetches the ids of workflow runs GitHub currently considers queued or in-progress. Used by the
 * sweep to detect DO job records stuck reporting an active CI status whose run was actually
 * terminated out-of-band (a manual `gh run cancel`, which skips `if: failure()` so our callback
 * never fires, or a runner that vanished without GitHub itself marking it stalled) -- those never
 * resolve via the normal callback path and would otherwise occupy a concurrency slot until the 6h
 * stall timeout.
 *
 * Returns actual run ids (a Set), not a count: a job record only gets to name a specific run id
 * (`ciRunHint`, set from the first callback that includes one) once CI has proven it's really
 * running by calling back at least once. The sweep only ever treats a record as orphaned when its
 * OWN named run is provably gone from this set -- never by comparing aggregate counts. A raw
 * count mismatch can't say which records are the problem, and a job legitimately mid-transcode
 * can go untouched for many minutes between callbacks, so guessing off "oldest updatedAt" or
 * count deltas WILL misidentify real in-flight jobs (this shipped once and killed 3 genuinely
 * running jobs in testing -- see job-registry.ts's handleSweep for the fix).
 *
 * Returns null on any failure so the caller can skip this reconciliation rather than trust a
 * partial/wrong result -- this is a best-effort cross-check, not a source of truth to act on
 * blindly.
 */
export async function fetchActiveRunIds(env: Env): Promise<Set<number> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNS_QUERY_TIMEOUT_MS);

  const fetchIds = async (status: "in_progress" | "queued"): Promise<number[] | null> => {
    const url =
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs` +
      `?status=${status}&per_page=100`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ci-transcode-worker",
      },
    });
    if (!res.ok) return null;
    const data = await res.json<{ workflow_runs?: Array<{ id: number }> }>();
    if (!Array.isArray(data.workflow_runs)) return null;
    return data.workflow_runs.map((r) => r.id);
  };

  try {
    // A "dispatching"/"downloading" job's run may still be GitHub-side "queued" (not yet picked
    // up by a runner), not just "in_progress" -- check both.
    const [inProgress, queued] = await Promise.all([fetchIds("in_progress"), fetchIds("queued")]);
    if (inProgress === null || queued === null) return null;
    return new Set([...inProgress, ...queued]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
