# ModelForge API Contracts

> **Version:** 1.0.0  
> **Base URL (dev):** `http://localhost:3000`  
> **Base URL (prod):** `https://api.theshriks.space`  
> **Owner:** Parth (backend)  
> **Consumers:** Shrusti (React frontend), Laukik (Python/NeMo service)

---

## Global Rules

### Content Type
All APIs return `Content-Type: application/json`  
**Exception:** `GET /compliance/:modelId/download` returns `application/zip`

### Authentication
All protected routes require header:
```
Authorization: Bearer {accessToken}
```
- Access token lifetime: **15 minutes**
- Refresh token lifetime: **7 days**

### Error Shape (ALL errors, no exceptions)
```json
{ "error": "Human readable message", "code": "MACHINE_CODE" }
```

### Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_INPUT` | 400 | Zod validation failed |
| `FILE_TOO_LARGE` | 413 | Upload exceeds size limit |
| `UNAUTHORIZED` | 401 | Missing / invalid / expired token |
| `FORBIDDEN` | 403 | Valid token, wrong ownership or role |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `CONFLICT` | 409 | Duplicate resource |
| `STORAGE_ERROR` | 500 | MinIO operation failed |
| `QUEUE_ERROR` | 503 | BullMQ unavailable |
| `PYTHON_SERVICE_ERROR` | 502 | Laukik's FastAPI unreachable or errored |
| `INTERNAL_ERROR` | 500 | Unhandled server error |
| `RATE_LIMITED` | 429 | Too many requests |

### Rate Limits

| Scope | Window | Max Requests |
|-------|--------|-------------|
| Default (all routes) | 15 min | 100 |
| Auth endpoints | 15 min | 20 |
| File upload | 15 min | 30 |
| Inference gateway | 1 min | 60 per apiKey |

---

## Auth Endpoints — No auth required

### `POST /auth/signup`

**Request body (JSON):**
```json
{
  "name": "string",
  "email": "string",
  "password": "string",
  "role": "RESEARCHER | SAFETY_ADMIN | COMPLIANCE | EXECUTIVE"
}
```

**Constraints:**
- `name`: min 2 chars, max 100 chars
- `email`: valid email format
- `password`: min 8 chars
- `role`: optional, defaults to `RESEARCHER`

**Success `201 Created`:**
```json
{
  "accessToken": "string (JWT)",
  "refreshToken": "string (JWT)",
  "user": { "id": "uuid", "name": "string", "email": "string" }
}
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Validation failed |
| 409 | `CONFLICT` | Email already registered |

---

### `POST /auth/login`

**Request body (JSON):**
```json
{ "email": "string", "password": "string" }
```

**Success `200 OK`:**
```json
{
  "accessToken": "string (JWT)",
  "refreshToken": "string (JWT)",
  "user": { "id": "uuid", "name": "string", "email": "string" }
}
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Validation failed |
| 401 | `UNAUTHORIZED` | Wrong email or password |

> **Security:** Same error message whether email or password is wrong — never leaks which one failed. Constant-time bcrypt comparison prevents timing attacks.

---

### `POST /auth/refresh`

**Request body (JSON):**
```json
{ "refreshToken": "string" }
```

**Success `200 OK`:**
```json
{ "accessToken": "string (JWT)" }
```

> **Note:** Returns a new access token only. Does NOT return a new refresh token.

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Missing field |
| 401 | `UNAUTHORIZED` | Token invalid, expired, or already used |

> **Security:** On reuse detection (same refresh token used twice), ALL refresh tokens for that user are invalidated immediately. Shrusti: if refresh returns 401, redirect to login screen — the session is compromised.

---

## Projects — Auth required

### `GET /projects`

**Query params:** none

**Success `200 OK`:**
```json
[
  {
    "id": "uuid",
    "name": "string",
    "createdAt": "ISO8601",
    "modelCount": 0,
    "jobCount": 0
  }
]
```

> Returns `[]` (empty array) if no projects — never 404.  
> Scoped to authenticated user only — never returns other users' projects.

---

### `POST /projects`

**Request body (JSON):**
```json
{ "name": "string" }
```

**Constraints:**
- `name`: min 1 char after trim, max 100 chars

**Success `201 Created`:**
```json
{ "id": "uuid", "name": "string", "createdAt": "ISO8601" }
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Validation failed |

---

## Datasets — Auth required

### `POST /datasets/upload`

**Request:** `multipart/form-data`

| Field | Type | Required |
|-------|------|----------|
| `file` | File | Yes |
| `projectId` | string (uuid) | Yes (body field) |

**Accepted MIME types:** `text/csv`, `application/json`, `application/pdf`, `text/plain`  
**Max file size:** 25 MB

**Success `201 Created`:**
```json
{
  "datasetId": "uuid",
  "fileName": "string",
  "sampleCount": 0,
  "qualityScore": 0.0
}
```

**sampleCount extraction logic:**
- CSV/TXT: lines − 1 (header excluded)
- JSON: array length (or 1 if not array)
- PDF: estimated heuristic (`floor(bytes / 800)`)

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | No file, missing projectId, unsupported MIME type |
| 403 | `FORBIDDEN` | projectId doesn't belong to this user |
| 404 | `NOT_FOUND` | projectId doesn't exist |
| 413 | `FILE_TOO_LARGE` | File exceeds 25 MB |
| 500 | `STORAGE_ERROR` | MinIO save failed (DB record rolled back) |

---

### `GET /datasets`

**Query params:**

| Param | Required | Notes |
|-------|----------|-------|
| `projectId` | **Required** | UUID. Returns datasets for this project only. |

**Success `200 OK`:**
```json
[
  {
    "id": "uuid",
    "name": "string",
    "sampleCount": 0,
    "qualityScore": 0.0,
    "createdAt": "ISO8601"
  }
]
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Missing or invalid projectId |
| 403 | `FORBIDDEN` | Project doesn't belong to this user |
| 404 | `NOT_FOUND` | projectId doesn't exist |

---

## Jobs — Auth required

### `POST /jobs/train`

**Request body (JSON):**
```json
{
  "projectId": "uuid",
  "datasetId": "uuid",
  "modelName": "string",
  "method": "finetune | qlora | rlhf | rlaif",
  "hyperparams": {
    "epochs": 3,
    "batchSize": 32,
    "learningRate": 0.0001
  }
}
```

**Constraints:**
- `modelName`: min 1 char, max 100 chars
- `method`: one of `finetune`, `qlora`, `rlhf`, `rlaif` — defaults to `finetune`
- `hyperparams`: optional, defaults to `{}`
  - `epochs`: integer 1–100 (optional)
  - `batchSize`: integer 1–256 (optional)
  - `learningRate`: positive number (optional)

**Success `202 Accepted`:**
```json
{
  "jobId": "uuid",
  "status": "queued",
  "estimatedCost": 2.40,
  "estimatedDuration": "~45m"
}
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Validation failed |
| 403 | `FORBIDDEN` | Project doesn't belong to user, or dataset doesn't belong to project |
| 404 | `NOT_FOUND` | projectId or datasetId doesn't exist |
| 409 | `CONFLICT` | Job already QUEUED or RUNNING for same dataset + model name |
| 503 | `QUEUE_ERROR` | BullMQ unavailable (job DB record deleted on failure) |

---

### `GET /jobs/:id/status`

**Success `200 OK`:**
```json
{
  "status": "queued | running | completed | failed",
  "progress": 0,
  "currentLoss": null,
  "step": null,
  "totalSteps": null,
  "eta": null,
  "cost": 2.40
}
```

> `cost` returns `actualCost` when available, otherwise `estimatedCost`.  
> On `"failed"` status, response includes additional `"error": "message"` field.

**Errors:**
| Status | Code | When |
|--------|------|------|
| 403 | `FORBIDDEN` | Job doesn't belong to this user |
| 404 | `NOT_FOUND` | Job doesn't exist |

---

## Models — Auth required

### `GET /models`

**Query params:**

| Param | Required | Notes |
|-------|----------|-------|
| `projectId` | **Required** | UUID. Returns models for this project only. |

**Success `200 OK`:**
```json
[
  {
    "id": "uuid",
    "name": "string",
    "version": "1.0.0",
    "baseModel": "finetune",
    "benchmarks": {},
    "deployedAt": "ISO8601 | null",
    "status": "trained | evaluating | evaluated | deploying | deployed | archived"
  }
]
```

> `benchmarks` is a JSON object, may be `{}` if no evals run yet.  
> `status` is always lowercase.

**Errors:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_INPUT` | Missing or invalid projectId |
| 403 | `FORBIDDEN` | Project doesn't belong to this user |
| 404 | `NOT_FOUND` | Project doesn't exist |

---

### `POST /models/:id/deploy`

**Request body:** none required

**Success `200 OK`:**
```json
{
  "apiUrl": "https://api.theshriks.space/infer/{modelId}",
  "apiKey": "mf_abc123...",
  "latencyMs": 120,
  "status": "live"
}
```

> [!CAUTION]
> **SHRUSTI — CRITICAL:** `apiKey` is shown **EXACTLY ONCE** in this response.  
> It is hashed (SHA-256) before storage. It **cannot be retrieved again**.  
> Frontend **MUST** display it immediately and prompt the user to copy it.

**Errors:**
| Status | Code | When |
|--------|------|------|
| 403 | `FORBIDDEN` | Model doesn't belong to this user |
| 404 | `NOT_FOUND` | Model doesn't exist |
| 409 | `CONFLICT` | Model already deployed, or model status not TRAINED/EVALUATED |
| 502 | `PYTHON_SERVICE_ERROR` | NIM pack failed |

---

## Eval — Auth required

### `GET /eval/:modelId`

**Success `200 OK`:**
```json
{
  "modelId": "uuid",
  "benchmarks": {
    "mmlu": null,
    "humaneval": null,
    "mtbench": null,
    "truthfulqa": null
  },
  "customEval": null
}
```

> `benchmarks` values are `number | null` — null means that benchmark hasn't run yet.  
> `customEval` is `null` if no custom evals exist. When present:
> ```json
> { "passed": 0, "total": 0 }
> ```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 403 | `FORBIDDEN` | Model doesn't belong to this user |
| 404 | `NOT_FOUND` | Model doesn't exist |

---

## Compliance — Auth required, role-restricted

**Allowed roles:** `COMPLIANCE`, `EXECUTIVE` only.  
All other roles receive `403 FORBIDDEN`.

### `GET /compliance/:modelId/download`

**Success `200 OK`:**
- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="compliance-{modelName}-v{version}.zip"`
- Body: binary ZIP stream (streamed via `archiver`, never buffered in memory)

> ZIP contains all files stored under `compliance-docs/{modelId}/` in MinIO.

**Errors:**
| Status | Code | When |
|--------|------|------|
| 403 | `FORBIDDEN` | Wrong role, or model doesn't belong to this user |
| 404 | `NOT_FOUND` | Model doesn't exist |
| 500 | `STORAGE_ERROR` | MinIO listing/read failed |

---

## Inference Gateway — API Key auth (not Bearer JWT)

### `POST /infer/:deploymentId`

**Auth:** Header `Authorization: Bearer {apiKey}` (this is the deployment apiKey from `/models/:id/deploy`, NOT a user JWT)

> [!IMPORTANT]
> **This uses `Authorization: Bearer` with the deployment apiKey, NOT a user JWT.**  
> Rate limiting is per apiKey (60 req/min), not per IP.

**Request body (JSON):**
```json
{ "prompt": "string", "maxTokens": 256 }
```

**Success `200 OK`:**
```json
{
  "response": "string",
  "tokensUsed": 42,
  "latencyMs": 230,
  "model": "string (model name)"
}
```

**Errors:**
| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | apiKey missing or invalid |
| 404 | `NOT_FOUND` | Deployment doesn't exist |
| 429 | `RATE_LIMITED` | Rate limit exceeded for this apiKey |
| 502 | `PYTHON_SERVICE_ERROR` | NIM inference failed |
| 504 | `PYTHON_SERVICE_ERROR` | NIM inference timed out (>30s) |

---

## Health Check — No auth required

### `GET /health`

**Success `200 OK`:**
```json
{ "status": "ok", "timestamp": "ISO8601" }
```

---

## ShrikDB WebSocket — Real-time training events

**Connection URL:**
- Dev: `ws://localhost:3000/ws?jobId={jobId}`
- Prod: `wss://theshriks.space/ws?jobId={jobId}`

> [!WARNING]
> **Cloudflare blocks WebSocket by default.**  
> Before going live: CF Dashboard → theshriks.space → Network → **WebSockets → ON**

**Keepalive:** Server pings every 30s. Client must respond with pong. Dead connections terminated after 10s of no pong.

### Events Shrusti should listen for

**`training.step`** — emitted every 5s while training
```json
{
  "event_type": "training.step",
  "jobId": "uuid",
  "projectId": "uuid",
  "step": 150,
  "totalSteps": 1000,
  "loss": 0.342,
  "lr": 0.0001,
  "gpuUtil": 87.5,
  "timestamp": "ISO8601"
}
```

**`training.completed`** — emitted once when training finishes
```json
{
  "event_type": "training.completed",
  "jobId": "uuid",
  "checkpointPath": "string",
  "finalLoss": 0.12,
  "totalSteps": 1000,
  "durationMin": 45,
  "costUSD": 2.40,
  "timestamp": "ISO8601"
}
```

**`training.failed`** — emitted on permanent failure
```json
{
  "event_type": "training.failed",
  "jobId": "uuid",
  "projectId": "uuid",
  "error": "Human readable error message",
  "timestamp": "ISO8601"
}
```

---

## Laukik's Python Endpoints (what Parth's backend calls)

These are the endpoints Laukik must implement. Parth's backend calls these and expects these exact response shapes.

| Method | Route | Parth Sends | Laukik Returns |
|--------|-------|------------|----------------|
| POST | `/nemo/finetune` | `{ jobId, datasetId, modelName, hyperparams }` | `{ jobId, status: "started", checkpointDir }` |
| POST | `/nemo/qlora` | `{ jobId, datasetId, modelName, hyperparams }` | `{ jobId, status: "started", method: "QLoRA" }` |
| POST | `/nemo/rlhf` | same | `{ jobId, status: "started", rewardModelPath }` |
| POST | `/nemo/rlaif` | same | `{ jobId, preferencePairsGenerated, status: "started" }` |
| GET | `/nemo/job/:jobId` | — | `{ status, step, totalSteps, loss, lr, gpuUtil }` |
| POST | `/nemo/nim-pack` | `{ modelId, checkpointPath }` | `{ nimImagePath, apiPort, status: "ready" }` |

> Parth polls `GET /nemo/job/:jobId` every **5 seconds** max. Timeout per request: **30 seconds**.
