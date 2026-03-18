// ShrikDB Event Type Definitions
// Every mutation in the system is an event.
// These define the exact payload shapes for each event type.

// ── Enums (match Prisma schema exactly) ────────────────

export type Role = 'RESEARCHER' | 'SAFETY_ADMIN' | 'COMPLIANCE' | 'EXECUTIVE';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type ModelStatus = 'TRAINED' | 'EVALUATING' | 'EVALUATED' | 'DEPLOYING' | 'DEPLOYED' | 'ARCHIVED';

// ── Entity Types (in-memory shape) ─────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface RefreshToken {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  used: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Dataset {
  id: string;
  projectId: string;
  fileName: string;
  fileType: string;
  minioPath: string;
  sampleCount: number;
  qualityScore: number;
  createdAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  datasetId: string;
  modelName: string;
  method: string;
  hyperparams: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  currentLoss: number | null;
  currentStep: number | null;
  totalSteps: number | null;
  eta: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  nemoJobId: string | null;
  checkpointPath: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Model {
  id: string;
  projectId: string;
  jobId: string;
  name: string;
  version: string;
  parentVersion: string | null;
  baseModel: string;
  checkpointPath: string | null;
  status: ModelStatus;
  benchmarks: Record<string, unknown> | null;
  deployedAt: string | null;
  createdAt: string;
}

export interface Deployment {
  id: string;
  modelId: string;
  apiUrl: string;
  apiKey: string;
  nimImagePath: string | null;
  latencyMs: number | null;
  tokensPerSec: number | null;
  status: string;
  createdAt: string;
}

export interface EvalResult {
  id: string;
  modelId: string;
  benchmark: string;
  score: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  userId: string;
  jobId: string | null;
  gpuHours: number;
  costUSD: number;
  recordedAt: string;
}

export interface Guardrail {
  id: string;
  modelId: string;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Event Payload Types ────────────────────────────────

export interface UserCreatedPayload {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  createdAt: string;
}

export interface UserUpdatedPayload {
  id: string;
  updates: Partial<Pick<User, 'name' | 'email' | 'role' | 'passwordHash'>>;
  updatedAt: string;
}

export interface RefreshTokenCreatedPayload {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface RefreshTokenUsedPayload {
  id: string;
}

export interface RefreshTokenInvalidatedPayload {
  userId: string;
}

export interface ProjectCreatedPayload {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
}

export interface ProjectUpdatedPayload {
  id: string;
  updates: Partial<Pick<Project, 'name'>>;
  updatedAt: string;
}

export interface DatasetUploadedPayload {
  id: string;
  projectId: string;
  fileName: string;
  fileType: string;
  minioPath: string;
  sampleCount: number;
  qualityScore: number;
  createdAt: string;
}

export interface DatasetDeletedPayload {
  id: string;
}

export interface JobCreatedPayload {
  id: string;
  projectId: string;
  datasetId: string;
  modelName: string;
  method: string;
  hyperparams: Record<string, unknown>;
  estimatedCost: number | null;
  createdAt: string;
}

export interface JobStatusUpdatedPayload {
  id: string;
  status: JobStatus;
  nemoJobId?: string;
  checkpointPath?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  actualCost?: number;
}

export interface JobProgressUpdatedPayload {
  id: string;
  progress: number;
  currentLoss?: number;
  currentStep?: number;
  totalSteps?: number;
  eta?: string;
}

export interface ModelCreatedPayload {
  id: string;
  projectId: string;
  jobId: string;
  name: string;
  version: string;
  parentVersion: string | null;
  baseModel: string;
  checkpointPath: string | null;
  createdAt: string;
}

export interface ModelStatusUpdatedPayload {
  id: string;
  status: ModelStatus;
  benchmarks?: Record<string, unknown>;
  deployedAt?: string;
}

export interface DeploymentCreatedPayload {
  id: string;
  modelId: string;
  apiUrl: string;
  apiKey: string;
  nimImagePath: string | null;
  latencyMs: number | null;
  tokensPerSec: number | null;
  status: string;
  createdAt: string;
}

export interface DeploymentUpdatedPayload {
  id: string;
  updates: Partial<Pick<Deployment, 'status' | 'latencyMs' | 'tokensPerSec' | 'apiUrl'>>;
}

export interface EvalResultCreatedPayload {
  id: string;
  modelId: string;
  benchmark: string;
  score: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UsageRecordedPayload {
  id: string;
  userId: string;
  jobId: string | null;
  gpuHours: number;
  costUSD: number;
  recordedAt: string;
}

export interface GuardrailUpsertedPayload {
  id: string;
  modelId: string;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Event Type Constants ───────────────────────────────

export const EVENT_TYPES = {
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  REFRESH_TOKEN_CREATED: 'refresh_token.created',
  REFRESH_TOKEN_USED: 'refresh_token.used',
  REFRESH_TOKEN_INVALIDATED: 'refresh_token.invalidated',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  DATASET_UPLOADED: 'dataset.uploaded',
  DATASET_DELETED: 'dataset.deleted',
  JOB_CREATED: 'job.created',
  JOB_STATUS_UPDATED: 'job.status_updated',
  JOB_PROGRESS_UPDATED: 'job.progress_updated',
  MODEL_CREATED: 'model.created',
  MODEL_STATUS_UPDATED: 'model.status_updated',
  DEPLOYMENT_CREATED: 'deployment.created',
  DEPLOYMENT_UPDATED: 'deployment.updated',
  EVAL_RESULT_CREATED: 'eval.result.created',
  USAGE_RECORDED: 'usage.recorded',
  GUARDRAIL_UPSERTED: 'guardrail.upserted',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];
