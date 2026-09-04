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
