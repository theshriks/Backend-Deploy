# Cloudflare R2 Setup — ModelForge Storage

## Why R2

- Local Docker MinIO loses data on Railway container restart
- R2 is S3-compatible — the MinIO JS SDK works with zero code changes
- Free tier: 10GB storage, 10M Class B operations/month
- Permanent, production-grade object storage

## Step 1: Create R2 Bucket

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Left sidebar → **R2 Object Storage** → **Create bucket**
3. Bucket name: `modelforge-storage`
4. Location: choose closest region to your Railway deployment

> [!IMPORTANT]
> We use **ONE bucket** with path prefixes instead of 4 separate buckets.
> Path structure inside the bucket:
> ```
> datasets/{projectId}/{filename}
> checkpoints/{jobId}/{filename}
> models/{modelId}/{filename}
> compliance-docs/{modelId}/{filename}
> ```
> The backend code handles this automatically via `MINIO_BUCKET` env var.

## Step 2: Create API Token

1. After creating the bucket → **Settings** tab
2. **R2 API Tokens** → **Create API Token**
3. Token name: `modelforge-backend`
4. Permissions: **Object Read & Write**
5. Specify bucket: `modelforge-storage` (limit scope)
6. TTL: No expiration (or set as needed)
7. Click **Create API Token**

## Step 3: Copy Credentials

You'll receive **3 values** — save them immediately:

| Value | Maps to env var |
|-------|-----------------|
| Access Key ID | `MINIO_ACCESS_KEY` |
| Secret Access Key | `MINIO_SECRET_KEY` |
| Endpoint URL | `MINIO_URL` |

The endpoint URL format is:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

> [!CAUTION]
> The Secret Access Key is shown **only once**. Copy it now or regenerate the token.

## Step 4: Set Environment Variables

Add to your `.env` (local) or Railway env vars (production):

```env
MINIO_URL=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
MINIO_ACCESS_KEY=<your-access-key-id>
MINIO_SECRET_KEY=<your-secret-access-key>
MINIO_BUCKET=modelforge-storage
```

When `MINIO_BUCKET` is set, the backend switches to single-bucket mode.
When `MINIO_BUCKET` is empty/unset, the backend uses 4 separate buckets (legacy/local mode).

## Step 5: Verify Connection

After setting env vars, build and test:

```bash
npm run build
node -e "
  require('dotenv').config();
  const { ensureBuckets } = require('./dist/lib/minio');
  ensureBuckets()
    .then(() => console.log('R2: OK'))
    .catch((err) => console.error('R2 FAIL:', err.message));
"
```

- **PASS**: `R2: OK`
- **FAIL**: Check endpoint URL, access key, secret key. Common issues:
  - Wrong endpoint format (must include `https://`)
  - Token doesn't have write permissions
  - Bucket name mismatch

## How It Works (For Teammates)

The `src/lib/minio.ts` module has a `resolve()` function:

- **Single-bucket mode** (`MINIO_BUCKET=modelforge-storage`):
  - `putObject('datasets', 'abc/file.csv')` → R2: `modelforge-storage/datasets/abc/file.csv`
  - `listObjects('compliance-docs', 'modelId/')` → R2: `modelforge-storage/compliance-docs/modelId/`

- **Multi-bucket mode** (`MINIO_BUCKET` not set):
  - `putObject('datasets', 'abc/file.csv')` → MinIO: bucket `datasets`, key `abc/file.csv`
  - Uses 4 separate buckets as before (local Docker MinIO)

No caller code changes needed — the wrappers handle everything.
