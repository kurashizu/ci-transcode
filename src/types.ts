export interface Env {
  BUCKET: R2Bucket;
  JOB_REGISTRY: DurableObjectNamespace;

  // secrets (wrangler secret put) — only genuinely sensitive credentials
  GITHUB_TOKEN: string;
  INTERNAL_CALLBACK_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  // vars ([vars] in wrangler.toml) — non-sensitive configuration
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  DEFAULT_CRF: string;
  DEFAULT_PRESET: string;
  MAX_PARALLEL_JOBS: string;
  R2_QUOTA_BYTES: string;
  JOB_TTL_SECONDS: string;
  UPLOAD_URL_TTL_SECONDS: string;
  RESULT_URL_TTL_SECONDS: string;
  MAX_UPLOAD_BYTES: string;
}

export type JobStatus =
  | "awaiting_upload" // presigned PUT issued, waiting for user to upload source
  | "queued" // committed, waiting for a free CI concurrency slot
  | "dispatching" // repository_dispatch call in flight
  | "downloading" // CI: pulling source from R2
  | "transcoding" // CI: running ffmpeg
  | "uploading" // CI: pushing result to R2
  | "done"
  | "failed"
  | "expired";

export const AV1_PRESETS = [
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
] as const;
export type Av1Preset = (typeof AV1_PRESETS)[number];

export interface JobRecord {
  jobId: string;
  token: string; // opaque bearer credential, never logged/exposed except at creation
  status: JobStatus;
  createdAt: number; // epoch ms
  updatedAt: number;
  expiresAt: number; // epoch ms, TTL enforced

  sourceKey: string; // R2 object key, random, no original filename
  resultKey: string; // R2 object key for transcoded output
  sourceBytes: number | null; // set on commit, from R2 head after upload
  resultBytes: number | null;

  crf: number;
  preset: Av1Preset;

  error: string | null;
  ciRunHint: string | null; // opaque dispatch correlation id, not a github run id
}

export interface PublicJobView {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  crf: number;
  preset: Av1Preset;
  error: string | null;
}
