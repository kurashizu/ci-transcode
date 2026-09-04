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
  const url = new URL(`${s3Endpoint(env)}/${env.R2_BUCKET_NAME}/${key}`);
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
