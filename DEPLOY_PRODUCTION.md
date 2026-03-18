# Production Deployment — Railway

## Pre-Deploy Checklist

### 1. Verify Build Scripts

`package.json` must have:
```json
{
  "build": "prisma generate && tsc",
  "start": "node dist/index.js"
}
```

`Procfile` at repo root must have:
```
web: node dist/index.js
```

### 2. Local Production Build

```bash
npm run build
```

Must show zero TypeScript errors. If any errors: fix before pushing.

### 3. Local Production Run Test

```bash
NODE_ENV=production node dist/index.js
```

Then in another terminal:
```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","timestamp":"..."}
```

## Deploy Steps

### Step 1: Push to GitHub

```bash
git add -A
git commit -m "feat: R2 storage migration + guardrails + CI gate + worker routing"
git push origin main
```

### Step 2: Railway Project Setup

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select: `themodelforge/backend` (or your repo)
3. Railway auto-detects Node.js and runs `npm run build` + `npm start`

### Step 3: Set Environment Variables

In Railway dashboard → your service → **Variables** tab, add ALL of these:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `postgresql://...` | Supabase connection pooler URL |
| `DIRECT_URL` | `postgresql://...` | Supabase direct connection URL |
| `REDIS_URL` | `rediss://...` | Upstash Redis URL |
| `JWT_SECRET` | *(generate below)* | Access token signing |
| `JWT_REFRESH_SECRET` | *(generate below)* | Refresh token signing — **MUST differ from JWT_SECRET** |
| `MINIO_URL` | `https://<id>.r2.cloudflarestorage.com` | R2 endpoint |
| `MINIO_ACCESS_KEY` | *(from R2 token)* | R2 access key |
| `MINIO_SECRET_KEY` | *(from R2 token)* | R2 secret key |
| `MINIO_BUCKET` | `modelforge-storage` | R2 single-bucket mode |
| `PYTHON_SERVICE_URL` | *(leave empty)* | Set when Laukik deploys Python service |
| `SHRIKDB_URL` | *(leave empty)* | Set when ShrikDB is deployed |
| `NODE_ENV` | `production` | Enables production behaviors |
| `CI_DEPLOY_THRESHOLD` | `0.3` | Minimum benchmark score for deploy |

> [!WARNING]
> Do NOT set `PORT` manually — Railway auto-assigns it via `$PORT`.

Generate JWT secrets (run each one separately — values must differ):

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Step 4: Verify Deployment

After Railway deploys (check build logs for success):

```bash
curl https://<your-railway-url>.railway.app/health
# Expected: {"status":"ok","timestamp":"..."}
```

### Step 5: Smoke Tests on Live URL

Run these 5 checks against your Railway URL:

```bash
BASE=https://<your-railway-url>.railway.app

# 1. Health
curl $BASE/health

# 2. Signup
curl -X POST $BASE/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","password":"Str0ngP@ss!"}'

# 3. Login (use the email from step 2)
curl -X POST $BASE/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Str0ngP@ss!"}'

# 4. Create project (use token from step 2 or 3)
curl -X POST $BASE/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Test Project"}'

# 5. Health again
curl $BASE/health
```

All must return 2xx responses.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Build fails on `prisma generate` | Missing `DATABASE_URL` | Set `DATABASE_URL` env var |
| `ECONNREFUSED` on health | `PORT` hardcoded | Remove any hardcoded `PORT`, use `process.env.PORT` |
| 500 on signup | `JWT_SECRET` not set | Set both JWT secrets |
| Redis connection error | Wrong `REDIS_URL` | Use `rediss://` (note: double-s for TLS) |
| MinIO/R2 upload fails | Wrong R2 credentials | Verify `MINIO_URL`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` |
| Prisma migration error | Used `migrate dev` | Use `prisma migrate deploy` in production |

## After All 5 Pass

Share the Railway URL with:
- **Shrusti** (frontend): set as `VITE_API_URL` in Vercel env vars
- **Laukik** (Python): set as the callback URL for ShrikDB events
