import { AwsClient } from "aws4fetch";
import type { Env } from "./types";

function s3Endpoint(env: Env): string {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

async function presign(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  expiresSeconds: number,
): Promise<string> {
  const aws = client(env);
  // Encode each path segment individually (not the whole key) so literal "/" separators in a
  // multi-segment key like "sources/<jobId>/<file>" survive, while every other character is
  // safely escaped. Keys are always our own randomId()-generated hex today, but this must not
  // silently rely on that.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${s3Endpoint(env)}/${env.R2_BUCKET_NAME}/${encodedKey}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await aws.sign(
    new Request(url, { method }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

export function presignPut(env: Env, key: string, expiresSeconds: number): Promise<string> {
  return presign(env, "PUT", key, expiresSeconds);
}

export function presignGet(env: Env, key: string, expiresSeconds: number): Promise<string> {
  return presign(env, "GET", key, expiresSeconds);
}
