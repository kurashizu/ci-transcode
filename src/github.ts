import type { Env, JobRecord } from "./types";

/**
 * Triggers the transcode workflow via repository_dispatch. The payload intentionally carries
 * only opaque identifiers (jobId, R2 object keys, crf/preset, and a callback URL/secret) —
 * never the original filename or any user-supplied metadata.
 */
export async function dispatchTranscodeJob(
  env: Env,
  job: JobRecord,
  callbackUrl: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github dispatch failed: ${res.status} ${text.slice(0, 300)}`);
  }
}
