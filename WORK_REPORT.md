# ModelForge Backend — Work Report

**Date:** 18 March 2026
**Author:** Parth (Backend Lead)
**Stack:** Node.js 20 · Express 5 · TypeScript · Prisma 7 · BullMQ · MinIO · Redis · WebSocket

---

## 1. Project Structure

```
backend/
├── prisma/
│   └── schema.prisma          # 183 lines — 12 models, 3 enums
├── src/
│   ├── app.ts                 #  67 lines — Express app, CORS, helmet, routes
│   ├── index.ts               #  84 lines — HTTP server, WS init, graceful shutdown
│   ├── lib/
│   │   ├── logger.ts          #  11 lines — pino logger (pretty in dev, JSON in prod)
│   │   ├── minio.ts           #  85 lines — MinIO client, bucket helpers, upload/download
│   │   ├── prisma.ts          #  26 lines — Prisma 7 singleton with pg adapter
│   │   ├── queue.ts           #  50 lines — BullMQ training queue, typed job data
│   │   ├── redis.ts           #  22 lines — ioredis connection with error handling
│   │   └── shrikdb.ts         # 417 lines — WebSocket server, emitEvent, handleShrikDBEvent
│   ├── middleware/
│   │   ├── authenticate.ts    #  38 lines — JWT Bearer token verification
│   │   ├── authorize.ts       #  19 lines — Role-based access control (RBAC)
│   │   ├── errorHandler.ts    #  23 lines — Global error handler (Zod + status codes)
│   │   └── rateLimiter.ts     #  29 lines — 4 rate limiters (default, auth, upload, infer)
│   ├── routes/
│   │   ├── auth.ts            # 218 lines — signup, login, refresh token rotation
│   │   ├── compliance.ts      #  77 lines — compliance ZIP download (streamed)
│   │   ├── datasets.ts        # 250 lines — file upload to MinIO, list datasets
│   │   ├── eval.ts            #  84 lines — model evaluation benchmarks
│   │   ├── infer.ts           # 106 lines — inference gateway with proxy
│   │   ├── jobs.ts            # 123 lines — training job creation + status polling
│   │   ├── models.ts          # 130 lines — model listing + deployment
│   │   └── projects.ts        #  80 lines — project CRUD
│   ├── schemas/
│   │   ├── auth.schema.ts     #  24 lines — Zod: signup, login, refresh
│   │   ├── dataset.schema.ts  #  12 lines — Zod: upload validation
│   │   └── job.schema.ts      #  18 lines — Zod: training job creation
│   └── workers/
│       └── training.worker.ts # 322 lines — BullMQ worker: NeMo polling, DB updates
├── API_CONTRACTS.md           # 571 lines — canonical API spec for all teammates
├── prisma.config.ts           # Prisma config using DIRECT_URL (port 5432, not pooler)
├── Procfile                   # Railway deploy: web: node dist/index.js
├── package.json               # build: prisma generate && tsc
├── tsconfig.json              # strict mode, commonjs, ES2022 target
├── .env.example               # 12 env vars (canonical list)
└── .gitignore                 # node_modules/, dist/, .env, *.log
```

**Total source:** 24 TypeScript files, ~2,340 lines of production code

---

## 2. Database Schema (Prisma)

12 models, 3 enums, fully indexed:

| Model | Key Fields | Relations |
|-------|-----------|-----------|
| `User` | id, email (unique), name, passwordHash, role | → Projects, RefreshTokens, UsageRecords |
| `RefreshToken` | token (unique), userId, expiresAt, used | → User |
| `Project` | id, name, userId | → User, Datasets, Jobs, Models |
| `Dataset` | id, projectId, fileName, fileType, minioPath, sampleCount, qualityScore | → Project, Jobs |
| `Job` | id, projectId, datasetId, modelName, method, status, progress, currentLoss, nemoJobId | → Project, Dataset, Model, UsageRecords |
| `Model` | id, projectId, jobId (unique), name, version, baseModel, status, benchmarks | → Project, Job, Deployment, EvalResults |
| `Deployment` | id, modelId (unique), apiUrl, apiKey, status | → Model |
| `EvalResult` | id, modelId, benchmark, score, metadata | → Model |
| `UsageRecord` | id, userId, jobId, gpuHours, costUSD | → User, Job |

**Enums:** `Role` (RESEARCHER, SAFETY_ADMIN, COMPLIANCE, EXECUTIVE) · `JobStatus` (QUEUED, RUNNING, COMPLETED, FAILED) · `ModelStatus` (TRAINED, EVALUATING, EVALUATED, DEPLOYING, DEPLOYED, ARCHIVED)

---

## 3. API Endpoints (All Implemented)

Full specification is in `API_CONTRACTS.md` (571 lines). Summary:

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | /auth/signup | Public | Creates user, returns JWT access + refresh tokens |
| POST | /auth/login | Public | Validates credentials, returns tokens |
| POST | /auth/refresh | Public | Rotates refresh token, returns new access token |
| GET | /projects | Bearer | Lists user's projects with model/job counts |
| POST | /projects | Bearer | Creates a project |
| POST | /datasets/upload | Bearer | Uploads file to MinIO, extracts sample count |
| GET | /datasets?projectId= | Bearer | Lists datasets for a project (projectId required) |
| POST | /jobs/train | Bearer | Enqueues training job via BullMQ |
| GET | /jobs/:id/status | Bearer | Returns job progress, loss, step, ETA |
| GET | /models?projectId= | Bearer | Lists models for a project (projectId required) |
| POST | /models/:id/deploy | Bearer | Deploys model via NIM, returns API URL + key |
| GET | /eval/:modelId | Bearer | Returns benchmark scores + custom eval results |
| GET | /compliance/:modelId/download | Bearer + RBAC | Streams compliance docs as ZIP |
| POST | /infer/:deploymentId | Bearer (apiKey) | Proxies inference request to deployed model |
| GET | /health | Public | Returns `{"status":"ok"}` |

---

## 4. Authentication & Security

| Feature | Implementation |
|---------|---------------|
| Password hashing | bcrypt, cost factor 12 |
| Access token | JWT, 15 min TTL, signed with `JWT_SECRET` |
| Refresh token | JWT, 7 day TTL, signed with `JWT_REFRESH_SECRET` (different key) |
| Token rotation | Old refresh token marked `used=true` on each refresh |
| Token reuse detection | If used token is reused → all user's tokens invalidated |
| Timing attack prevention | Constant-time bcrypt compare on login (dummy hash for nonexistent users) |
| RBAC | 4 roles: RESEARCHER, SAFETY_ADMIN, COMPLIANCE, EXECUTIVE |
| CORS | Production: `theshriks.space` only. Dev: all origins |
| Rate limiting | 4 limiters: default (100/15m), auth (20/15m), upload (10/15m), infer (60/min) |
| Helmet | All security headers enabled |
| Inference auth | `Authorization: Bearer {apiKey}` with SHA-256 hash + timing-safe comparison |

---

## 5. Infrastructure Connections

| Service | Library | Status | Config |
|---------|---------|--------|--------|
| PostgreSQL | Prisma 7 + `@prisma/adapter-pg` | ✅ Connected | Supabase (ap-northeast-1) |
| Redis | ioredis | ✅ Connected | Upstash (rediss://) |
| MinIO | minio SDK | ✅ Connected | Docker localhost:9000 |
| BullMQ | bullmq | ✅ Connected | Uses same Redis connection |
| WebSocket | ws | ✅ Running | Path: `/ws?jobId={jobId}` |
| Python/NeMo | fetch (HTTP) | ⏳ Pending | `PYTHON_SERVICE_URL` not set — Laukik deploys |

**MinIO Buckets (all 4 exist):**
- `datasets` — uploaded training data (CSV, JSON, PDF)
- `checkpoints` — NeMo training checkpoints
- `models` — final trained model weights
- `compliance-docs` — model cards, EU AI Act docs

---

## 6. BullMQ Training Pipeline

```
POST /jobs/train
  → Zod validates body
  → Checks project ownership
  → Checks dataset belongs to project
  → Checks no duplicate job (same dataset+model already QUEUED/RUNNING → 409)
  → Creates Job record (status: QUEUED)
  → Enqueues to BullMQ "training" queue
  → Returns 202 { jobId, status: "queued", estimatedCost, estimatedDuration }

Training Worker (concurrency: 3):
  → Marks job RUNNING in DB
  → POSTs to Laukik's Python NeMo endpoint
  → Polls NeMo status every 5s (max ~166 hours timeout)
  → On each poll: updates DB (step, loss, progress) + broadcasts WebSocket event
  → On completion: marks COMPLETED, creates Model record, creates UsageRecord
  → On failure: marks FAILED, broadcasts training.failed event
  → BullMQ auto-retries 3x with exponential backoff (5s, 10s, 20s)
```

---

## 7. ShrikDB (WebSocket Event System)

`shrikdb.ts` is the real-time event broadcaster for the frontend.

**What exists today:**
- WebSocket server on `/ws?jobId={jobId}`
- Per-job client isolation using `Map<string, Set<WebSocket>>`
- `broadcastToJob(jobId, payload)` — sends event to all connected clients for a job
- Ping every 30s, pong timeout 10s — dead clients removed automatically
- `emitEvent(eventType, payload)` — broadcasts locally + POSTs to ShrikDB WAL if `SHRIKDB_URL` is set
- `handleShrikDBEvent(event)` — processes inbound events, updates DB, broadcasts to clients
- `testEventEmit()` — runs on dev startup to verify wiring

**10 event types defined:**
`training.step` · `training.completed` · `training.failed` · `eval.result` · `eval.completed` · `safety.violation` · `redteam.completed` · `deploy.live` · `model.version.created` · `compliance.generated`

**Current state:** `SHRIKDB_URL` is not set → `emitEvent()` only broadcasts locally via WebSocket. WAL logging will activate automatically when `SHRIKDB_URL` is configured — no code changes needed.

---

## 8. Edge Cases Handled

Every route handler follows this pattern:
1. Zod validates input → 400 INVALID_INPUT
2. Check resource exists → 404 NOT_FOUND
3. Check ownership → 403 FORBIDDEN
4. Check duplicates → 409 CONFLICT
5. DB errors → .catch() → 500 INTERNAL_ERROR
6. External service errors → 502/503

| Edge Case | How It's Handled |
|-----------|-----------------|
| Empty/missing request fields | Zod catches → 400 |
| Wrong types in request | Zod catches → 400 |
| Resource not found | 404, never 500 |
| User doesn't own resource | 403 FORBIDDEN |
| Duplicate email signup | 409 CONFLICT |
| Duplicate training job | 409 CONFLICT with existing jobId |
| JWT expired | 401 (same message as tampered) |
| JWT tampered | 401 (same message as expired — no info leak) |
| Refresh token reuse | 401 + invalidate entire user session |
| File wrong MIME type | 400 before touching MinIO |
| File too large (>25MB) | 413 FILE_TOO_LARGE |
| MinIO save failure | Rollback DB record, return STORAGE_ERROR |
| BullMQ enqueue failure | Rollback job record → 503 QUEUE_ERROR |
| Worker crash mid-job | BullMQ auto-retries (3 attempts) |
| NeMo timeout | Job marked FAILED, training.failed event broadcast |
| WS client disconnect | Removed from Map, no crash |
| Python service unreachable | 502 PYTHON_SERVICE_ERROR |

---

## 9. Production Readiness

| Check | Status |
|-------|--------|
| `tsc --noEmit` | ✅ Zero errors |
| `npm run build` (prisma generate && tsc) | ✅ Zero errors, 92 compiled files in dist/ |
| `node dist/index.js` (production mode) | ✅ Starts, serves /health, completes signup |
| `npx prisma validate` | ✅ Schema valid |
| Zero `console.log` in source | ✅ All logging via pino |
| Zero `any` types | ✅ TypeScript strict mode |
| Graceful shutdown (SIGTERM/SIGINT) | ✅ Closes HTTP → Worker → Queue → Redis → Prisma |
| Error response format | ✅ Always `{ error: string, code: string }` |
| Procfile | ✅ `web: node dist/index.js` |
| postinstall | ✅ `prisma generate` |

---

## 10. Environment Variables (12 total)

All vars used in code are documented in `.env.example`:

| Variable | Purpose | Currently Set |
|----------|---------|---------------|
| `DATABASE_URL` | Supabase PostgreSQL (pooled, port 6543) | ✅ |
| `DIRECT_URL` | Supabase PostgreSQL (direct, port 5432, for migrations) | ✅ |
| `REDIS_URL` | Upstash Redis (for BullMQ + caching) | ✅ |
| `JWT_SECRET` | Access token signing | ✅ |
| `JWT_REFRESH_SECRET` | Refresh token signing (different from JWT_SECRET) | ✅ |
| `MINIO_URL` | MinIO endpoint | ✅ (localhost:9000) |
| `MINIO_ACCESS_KEY` | MinIO access key | ✅ |
| `MINIO_SECRET_KEY` | MinIO secret key | ✅ |
| `PYTHON_SERVICE_URL` | Laukik's NeMo FastAPI service | ❌ Empty |
| `SHRIKDB_URL` | ShrikDB WAL endpoint | ❌ Empty (local broadcast only) |
| `PORT` | Server port (Railway auto-sets in production) | ✅ (3000) |
| `NODE_ENV` | Environment flag | ✅ (development) |

---

## 11. Phase 1 Gate Results (All 10 Pass)

| # | Test | Result |
|---|------|--------|
| 1 | Server health | ✅ `{"status":"ok"}` |
| 2 | API_CONTRACTS.md | ✅ 571 lines |
| 3 | .env.example complete | ✅ 12/12 vars |
| 4 | Production build | ✅ Zero errors |
| 5 | Prisma schema valid | ✅ |
| 6 | Database (Supabase) | ✅ Connected |
| 7 | Redis (Upstash) | ✅ PONG |
| 8 | MinIO + 4 buckets | ✅ All exist |
| 9 | ShrikDB testEventEmit | ✅ OK |
| 10 | BullMQ queue | ✅ Reachable |

---

## 12. What's Not Built Yet

| Item | Owner | Notes |
|------|-------|-------|
| Python NeMo service | Laukik | Set `PYTHON_SERVICE_URL` when deployed |
| ShrikDB WAL + Velocity Engine | Laukik | Set `SHRIKDB_URL` when deployed — code is ready |
| Frontend integration | Shrusti | Use `API_CONTRACTS.md` as spec |
| CI/CD (GitHub Actions) | Parth | Not set up yet |
| Dockerfile | Parth | Using Procfile for Railway |
| Automated tests (.test.ts) | Parth | No test files exist |
| Cloudflare WS toggle | Parth | Must enable WebSockets in CF dashboard before production |

---

## 13. For Shrusti (Frontend)

- Read `API_CONTRACTS.md` for every endpoint shape, status code, and error code
- All protected routes need `Authorization: Bearer {accessToken}` header
- Inference endpoint uses `Authorization: Bearer {apiKey}` (not the user's access token)
- WebSocket: connect to `wss://theshriks.space/ws?jobId={jobId}` for live training updates
- Error responses always shape: `{ "error": "message", "code": "MACHINE_CODE" }`

## 14. For Laukik (Python/NeMo)

- Parth's backend calls your endpoints defined in GEMINI.md §7
- Return shape must match exactly — Parth's code parses `jobId`, `status`, `checkpointDir`, etc.
- Training worker polls `GET /nemo/job/:jobId` every 5 seconds — don't rate-limit this
- When ShrikDB is ready: set `SHRIKDB_URL` in Parth's .env — `emitEvent()` will auto-POST to `{SHRIKDB_URL}/events`
- Confirm: is `POST /events` the correct WAL endpoint shape?
