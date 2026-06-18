import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { StorageBackend } from './lib/s3';

export interface Bindings {
  // D1
  DB: D1Database;

  // Native R2 binding (Cloudflare). When present, makeStorage() uses it directly
  // — no R2_ACCOUNT_ID / S3 keys / presigned URLs needed (see lib/r2-binding.ts).
  BUCKET?: R2Bucket;

  // Object storage backend. Normally built by makeStorage() from BUCKET (R2
  // binding) or the S3/R2 vars below. The Node runtime can inject a
  // local-filesystem backend here (see apps/worker/node/server.mjs).
  STORAGE?: StorageBackend;

  // Plain vars
  ALLOWED_ORIGINS: string;
  JWT_TTL_SECONDS: string;
  DOWNLOAD_URL_TTL_SECONDS: string;
  UPLOAD_PART_URL_TTL_SECONDS: string;
  // R2/S3 via the S3 API — only needed when NOT using the BUCKET binding
  // (e.g. self-hosted S3/MinIO). Optional otherwise.
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;

  // First-run admin auto-seed (used only when the users table is empty;
  // see lib/bootstrap.ts). All optional — sensible defaults apply.
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;

  // Optional S3 endpoint overrides for non-Cloudflare deployments
  // (e.g. self-hosted MinIO behind Docker). When unset, the client falls
  // back to the Cloudflare R2 endpoint derived from R2_ACCOUNT_ID.
  //   S3_ENDPOINT        — endpoint the server itself calls (e.g. http://minio:9000)
  //   S3_PUBLIC_ENDPOINT — endpoint baked into presigned URLs handed to browsers/devices
  //                        (must be reachable by those clients; defaults to S3_ENDPOINT)
  //   S3_REGION          — signing region (default 'auto')
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_REGION?: string;

  // Secrets
  JWT_SECRET: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export type GlobalRole = 'super_admin' | 'admin' | 'developer' | 'observer';
export type CustomerRole = 'customer_admin' | 'developer' | 'viewer';

export interface AuthedUser {
  id: number;
  email: string;
  role: GlobalRole;
}

export interface AuthedApiToken {
  id: number;
  projectId: number;
  kind: 'device' | 'ci';
  scope: 'download' | 'upload' | 'full';
  channel: string | null;
}

export interface AppVariables {
  user?: AuthedUser;
  apiToken?: AuthedApiToken;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};
