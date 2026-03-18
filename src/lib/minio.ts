import { Client } from 'minio';
import type { Readable } from 'stream';
import logger from './logger';

const MINIO_URL = process.env.MINIO_URL ?? '';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? '';

// ── R2 single-bucket mode ─────────────────────────────────────────
// When MINIO_BUCKET is set, all operations go to that single bucket
// with the logical bucket name as a path prefix.
// e.g. putObject('datasets', 'abc/file.csv') → putObject('modelforge-storage', 'datasets/abc/file.csv')
const SINGLE_BUCKET = process.env.MINIO_BUCKET ?? '';

let endPoint = 'localhost';
let port = 9000;
let useSSL = false;

if (MINIO_URL) {
  try {
    const url = new URL(MINIO_URL);
    endPoint = url.hostname;
    port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
    useSSL = url.protocol === 'https:';
  } catch {
    logger.warn({ MINIO_URL }, 'Invalid MINIO_URL — falling back to localhost:9000');
  }
}

export const minioClient = new Client({
  endPoint,
  port,
  useSSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
  pathStyle: true, // Required for R2 and local MinIO
});

export const BUCKETS = {
  DATASETS: 'datasets',
  CHECKPOINTS: 'checkpoints',
  MODELS: 'models',
  COMPLIANCE_DOCS: 'compliance-docs',
} as const;

export type BucketName = typeof BUCKETS[keyof typeof BUCKETS];

// ── Resolve bucket and object name for R2 single-bucket mode ──────
function resolve(bucket: string, objectName: string): { targetBucket: string; targetObject: string } {
  if (SINGLE_BUCKET) {
    return {
      targetBucket: SINGLE_BUCKET,
      targetObject: `${bucket}/${objectName}`,
    };
  }
  return { targetBucket: bucket, targetObject: objectName };
}

function resolveBucket(bucket: string): string {
  return SINGLE_BUCKET || bucket;
}

function resolvePrefix(bucket: string, prefix: string): string {
  return SINGLE_BUCKET ? `${bucket}/${prefix}` : prefix;
}

// ── Idempotent bucket creation (safe to call on every startup) ────
export async function ensureBuckets(): Promise<void> {
  const buckets = SINGLE_BUCKET
    ? [SINGLE_BUCKET]
    : Object.values(BUCKETS);

  for (const bucket of buckets) {
    try {
      const exists = await minioClient.bucketExists(bucket);
      if (!exists) {
        await minioClient.makeBucket(bucket);
        logger.info({ bucket }, 'Storage bucket created');
      }
    } catch (err) {
      logger.error({ err, bucket }, 'Failed to ensure storage bucket');
    }
  }
}

// ── Typed helpers — all operations route through resolve() ────────
export async function uploadFile(
  bucket: BucketName,
  objectName: string,
  buffer: Buffer,
  size: number,
  contentType: string,
): Promise<void> {
  const { targetBucket, targetObject } = resolve(bucket, objectName);
  const { Readable: ReadableStream } = await import('stream');
  const stream = ReadableStream.from(buffer);
  await minioClient.putObject(targetBucket, targetObject, stream, size, {
    'Content-Type': contentType,
  });
}

export async function putObjectStream(
  bucket: BucketName,
  objectName: string,
  stream: Readable,
  size: number,
  metaData: Record<string, string>,
): Promise<void> {
  const { targetBucket, targetObject } = resolve(bucket, objectName);
  await minioClient.putObject(targetBucket, targetObject, stream, size, metaData);
}

export async function getFileStream(
  bucket: BucketName,
  objectName: string,
): Promise<Readable> {
  const { targetBucket, targetObject } = resolve(bucket, objectName);
  return minioClient.getObject(targetBucket, targetObject);
}

export function listObjects(
  bucket: BucketName,
  prefix: string,
  recursive: boolean,
) {
  const b = resolveBucket(bucket);
  const p = resolvePrefix(bucket, prefix);
  return minioClient.listObjects(b, p, recursive);
}

export async function deleteFile(
  bucket: BucketName,
  objectName: string,
): Promise<void> {
  const { targetBucket, targetObject } = resolve(bucket, objectName);
  await minioClient.removeObject(targetBucket, targetObject);
}

export default minioClient;
