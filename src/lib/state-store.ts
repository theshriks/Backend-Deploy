// ShrikDB State Store — In-Memory Projections
// All state rebuilt from ShrikDB events on startup
// O(1) reads via Map lookups, writes append to ShrikDB then update Maps

import crypto from 'crypto';
import { shrikdbClient, type ShrikDBEvent } from './shrikdb-client';
import { logger } from './logger';
import {
  EVENT_TYPES,
  type User, type RefreshToken, type Project, type Dataset,
  type Job, type Model, type Deployment, type EvalResult,
  type UsageRecord, type Guardrail, type Role, type JobStatus,
  type ModelStatus,
  type UserCreatedPayload, type UserUpdatedPayload,
  type RefreshTokenCreatedPayload, type RefreshTokenUsedPayload,
  type RefreshTokenInvalidatedPayload,
  type ProjectCreatedPayload, type ProjectUpdatedPayload,
  type DatasetUploadedPayload, type DatasetDeletedPayload,
  type JobCreatedPayload, type JobStatusUpdatedPayload,
  type JobProgressUpdatedPayload,
  type ModelCreatedPayload, type ModelStatusUpdatedPayload,
  type DeploymentCreatedPayload, type DeploymentUpdatedPayload,
  type EvalResultCreatedPayload,
  type UsageRecordedPayload,
  type GuardrailUpsertedPayload,
} from './events';

// ── UUID Generator ─────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ── State Store Class ──────────────────────────────────

class StateStore {
  // Primary Maps (id → entity)
  private users = new Map<string, User>();
  private refreshTokens = new Map<string, RefreshToken>();
  private projects = new Map<string, Project>();
  private datasets = new Map<string, Dataset>();
  private jobs = new Map<string, Job>();
  private models = new Map<string, Model>();
  private deployments = new Map<string, Deployment>();
  private evalResults = new Map<string, EvalResult>();
  private usageRecords = new Map<string, UsageRecord>();
  private guardrails = new Map<string, Guardrail>();

  // Secondary indexes (for fast lookups)
  private usersByEmail = new Map<string, string>();        // email → userId
  private refreshTokensByToken = new Map<string, string>(); // token → tokenId
  private projectsByUser = new Map<string, Set<string>>();  // userId → Set<projectId>
  private datasetsByProject = new Map<string, Set<string>>(); // projectId → Set<datasetId>
  private jobsByProject = new Map<string, Set<string>>();   // projectId → Set<jobId>
  private modelsByProject = new Map<string, Set<string>>(); // projectId → Set<modelId>
  private modelByJob = new Map<string, string>();           // jobId → modelId
  private deploymentByModel = new Map<string, string>();    // modelId → deploymentId
  private evalsByModel = new Map<string, Set<string>>();    // modelId → Set<evalId>
  private guardrailByModel = new Map<string, string>();     // modelId → guardrailId
  private jobByNemoId = new Map<string, string>();          // nemoJobId → jobId

  private initialized = false;
  private eventCount = 0;

  private static readonly REPLAY_BATCH_SIZE = 1000;

  // ── Initialization ─────────────────────────────────

  async initialize(projectId: string): Promise<void> {
    const startTime = Date.now();

    // STRATEGY:
    // 1. If SHRIKDB_CLIENT_ID + SHRIKDB_CLIENT_KEY are set → use them directly (existing project)
    // 2. If not → create new project, log credentials for user to save as env vars
    const envClientId = process.env['SHRIKDB_CLIENT_ID'] ?? '';
    const envClientKey = process.env['SHRIKDB_CLIENT_KEY'] ?? '';

    if (envClientId && envClientKey) {
      // Existing project — use saved credentials
      shrikdbClient.setCredentials(envClientId, envClientKey, projectId);
      logger.info({ projectId }, 'Using existing ShrikDB credentials from env vars');
    } else {
      // New project — create and log credentials
      try {
        const res = await shrikdbClient.createProject(projectId);
        if (res.success) {
          logger.info({ projectId }, 'Created new ShrikDB project');
          // IMPORTANT: Log credentials so user can save them as env vars
          logger.warn({
            projectId,
            clientId: res.client_id,
            clientKey: res.client_key,
          }, '⚠️  SAVE THESE CREDENTIALS AS ENV VARS: SHRIKDB_CLIENT_ID and SHRIKDB_CLIENT_KEY. Server will need them on next restart.');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Project may already exist — try to parse credentials from error if possible
        if (msg.includes('already exists') || msg.includes('409') || msg.includes('400')) {
          logger.error({ projectId }, 'ShrikDB project already exists but no credentials in env vars. Set SHRIKDB_CLIENT_ID and SHRIKDB_CLIENT_KEY env vars.');
          throw new Error(
            `ShrikDB project "${projectId}" already exists. Set SHRIKDB_CLIENT_ID and SHRIKDB_CLIENT_KEY env vars from the initial project creation output.`
          );
        }
        throw new Error(`ShrikDB connection failed: ${msg}`);
      }
    }

    if (!shrikdbClient.isAuthenticated()) {
      throw new Error('ShrikDB authentication failed — cannot initialize state store');
    }

    // Replay all events to rebuild state — PAGINATED to prevent OOM
    let fromSequence = 0;
    let totalReplayed = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const events = await shrikdbClient.readEvents(fromSequence, StateStore.REPLAY_BATCH_SIZE);
      if (events.length === 0) break;

      for (const event of events) {
        this.applyEvent(event);
      }

      totalReplayed += events.length;
      fromSequence = events[events.length - 1].sequence_number + 1;

      if (events.length < StateStore.REPLAY_BATCH_SIZE) break; // Last batch
    }

    this.eventCount = totalReplayed;

    const elapsed = Date.now() - startTime;
    logger.info({
      eventCount: this.eventCount,
      users: this.users.size,
      projects: this.projects.size,
      datasets: this.datasets.size,
      jobs: this.jobs.size,
      models: this.models.size,
      elapsedMs: elapsed,
    }, 'State store initialized from ShrikDB replay');

    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('StateStore not initialized. Call initialize() first.');
    }
  }

  // ── Event Application (projection) ─────────────────

  private applyEvent(event: ShrikDBEvent): void {
    const p = event.payload as Record<string, unknown>;

    switch (event.event_type) {
      case EVENT_TYPES.USER_CREATED:
        this.applyUserCreated(p as unknown as UserCreatedPayload);
        break;
      case EVENT_TYPES.USER_UPDATED:
        this.applyUserUpdated(p as unknown as UserUpdatedPayload);
        break;
      case EVENT_TYPES.REFRESH_TOKEN_CREATED:
        this.applyRefreshTokenCreated(p as unknown as RefreshTokenCreatedPayload);
        break;
      case EVENT_TYPES.REFRESH_TOKEN_USED:
        this.applyRefreshTokenUsed(p as unknown as RefreshTokenUsedPayload);
        break;
      case EVENT_TYPES.REFRESH_TOKEN_INVALIDATED:
        this.applyRefreshTokenInvalidated(p as unknown as RefreshTokenInvalidatedPayload);
        break;
      case EVENT_TYPES.PROJECT_CREATED:
        this.applyProjectCreated(p as unknown as ProjectCreatedPayload);
        break;
      case EVENT_TYPES.PROJECT_UPDATED:
        this.applyProjectUpdated(p as unknown as ProjectUpdatedPayload);
        break;
      case EVENT_TYPES.DATASET_UPLOADED:
        this.applyDatasetUploaded(p as unknown as DatasetUploadedPayload);
        break;
      case EVENT_TYPES.DATASET_DELETED:
        this.applyDatasetDeleted(p as unknown as DatasetDeletedPayload);
        break;
      case EVENT_TYPES.JOB_CREATED:
        this.applyJobCreated(p as unknown as JobCreatedPayload);
        break;
      case EVENT_TYPES.JOB_STATUS_UPDATED:
        this.applyJobStatusUpdated(p as unknown as JobStatusUpdatedPayload);
        break;
      case EVENT_TYPES.JOB_PROGRESS_UPDATED:
        this.applyJobProgressUpdated(p as unknown as JobProgressUpdatedPayload);
        break;
      case EVENT_TYPES.MODEL_CREATED:
        this.applyModelCreated(p as unknown as ModelCreatedPayload);
        break;
      case EVENT_TYPES.MODEL_STATUS_UPDATED:
        this.applyModelStatusUpdated(p as unknown as ModelStatusUpdatedPayload);
        break;
      case EVENT_TYPES.DEPLOYMENT_CREATED:
        this.applyDeploymentCreated(p as unknown as DeploymentCreatedPayload);
        break;
      case EVENT_TYPES.DEPLOYMENT_UPDATED:
        this.applyDeploymentUpdated(p as unknown as DeploymentUpdatedPayload);
        break;
      case EVENT_TYPES.EVAL_RESULT_CREATED:
        this.applyEvalResultCreated(p as unknown as EvalResultCreatedPayload);
        break;
      case EVENT_TYPES.USAGE_RECORDED:
        this.applyUsageRecorded(p as unknown as UsageRecordedPayload);
        break;
      case EVENT_TYPES.GUARDRAIL_UPSERTED:
        this.applyGuardrailUpserted(p as unknown as GuardrailUpsertedPayload);
        break;
      default:
        logger.warn({ eventType: event.event_type }, 'Unknown event type during replay');
    }
  }

  // ── Projection Functions ───────────────────────────

  private applyUserCreated(p: UserCreatedPayload): void {
    const user: User = {
      id: p.id,
      email: p.email,
      name: p.name,
      passwordHash: p.passwordHash,
      role: p.role,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
  }

  private applyUserUpdated(p: UserUpdatedPayload): void {
    const user = this.users.get(p.id);
    if (!user) return;
    const oldEmail = user.email;
    Object.assign(user, p.updates, { updatedAt: p.updatedAt });
    if (p.updates.email && p.updates.email !== oldEmail) {
      this.usersByEmail.delete(oldEmail);
      this.usersByEmail.set(p.updates.email, user.id);
    }
  }

  private applyRefreshTokenCreated(p: RefreshTokenCreatedPayload): void {
    const token: RefreshToken = {
      id: p.id,
      token: p.token,
      userId: p.userId,
      expiresAt: p.expiresAt,
      used: false,
      createdAt: p.createdAt,
    };
    this.refreshTokens.set(token.id, token);
    this.refreshTokensByToken.set(token.token, token.id);
  }

  private applyRefreshTokenUsed(p: RefreshTokenUsedPayload): void {
    const token = this.refreshTokens.get(p.id);
    if (token) {
      token.used = true;
    }
  }

  private applyRefreshTokenInvalidated(p: RefreshTokenInvalidatedPayload): void {
    // Mark ALL tokens for this user as used
    for (const [, token] of this.refreshTokens) {
      if (token.userId === p.userId) {
        token.used = true;
      }
    }
  }

  private applyProjectCreated(p: ProjectCreatedPayload): void {
    const project: Project = {
      id: p.id,
      name: p.name,
      userId: p.userId,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    };
    this.projects.set(project.id, project);
    if (!this.projectsByUser.has(project.userId)) {
      this.projectsByUser.set(project.userId, new Set());
    }
    this.projectsByUser.get(project.userId)!.add(project.id);
  }

  private applyProjectUpdated(p: ProjectUpdatedPayload): void {
    const project = this.projects.get(p.id);
    if (!project) return;
    Object.assign(project, p.updates, { updatedAt: p.updatedAt });
  }

  private applyDatasetUploaded(p: DatasetUploadedPayload): void {
    const dataset: Dataset = {
      id: p.id,
      projectId: p.projectId,
      fileName: p.fileName,
      fileType: p.fileType,
      minioPath: p.minioPath,
      sampleCount: p.sampleCount,
      qualityScore: p.qualityScore,
      createdAt: p.createdAt,
    };
    this.datasets.set(dataset.id, dataset);
    if (!this.datasetsByProject.has(dataset.projectId)) {
      this.datasetsByProject.set(dataset.projectId, new Set());
    }
    this.datasetsByProject.get(dataset.projectId)!.add(dataset.id);
  }

  private applyDatasetDeleted(p: DatasetDeletedPayload): void {
    const dataset = this.datasets.get(p.id);
    if (dataset) {
      this.datasetsByProject.get(dataset.projectId)?.delete(dataset.id);
      this.datasets.delete(p.id);
    }
  }

  private applyJobCreated(p: JobCreatedPayload): void {
    const job: Job = {
      id: p.id,
      projectId: p.projectId,
      datasetId: p.datasetId,
      modelName: p.modelName,
      method: p.method,
      hyperparams: p.hyperparams,
      status: 'QUEUED',
      progress: 0,
      currentLoss: null,
      currentStep: null,
      totalSteps: null,
      eta: null,
      estimatedCost: p.estimatedCost,
      actualCost: null,
      nemoJobId: null,
      checkpointPath: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: p.createdAt,
    };
    this.jobs.set(job.id, job);
    if (!this.jobsByProject.has(job.projectId)) {
      this.jobsByProject.set(job.projectId, new Set());
    }
    this.jobsByProject.get(job.projectId)!.add(job.id);
  }

  private applyJobStatusUpdated(p: JobStatusUpdatedPayload): void {
    const job = this.jobs.get(p.id);
    if (!job) return;
    job.status = p.status;
    if (p.nemoJobId !== undefined) {
      if (job.nemoJobId) this.jobByNemoId.delete(job.nemoJobId);
      job.nemoJobId = p.nemoJobId;
      if (p.nemoJobId) this.jobByNemoId.set(p.nemoJobId, job.id);
    }
    if (p.checkpointPath !== undefined) job.checkpointPath = p.checkpointPath;
    if (p.errorMessage !== undefined) job.errorMessage = p.errorMessage;
    if (p.startedAt !== undefined) job.startedAt = p.startedAt;
    if (p.completedAt !== undefined) job.completedAt = p.completedAt;
    if (p.actualCost !== undefined) job.actualCost = p.actualCost;
  }

  private applyJobProgressUpdated(p: JobProgressUpdatedPayload): void {
    const job = this.jobs.get(p.id);
    if (!job) return;
    job.progress = p.progress;
    if (p.currentLoss !== undefined) job.currentLoss = p.currentLoss;
    if (p.currentStep !== undefined) job.currentStep = p.currentStep;
    if (p.totalSteps !== undefined) job.totalSteps = p.totalSteps;
    if (p.eta !== undefined) job.eta = p.eta;
  }

  private applyModelCreated(p: ModelCreatedPayload): void {
    const model: Model = {
      id: p.id,
      projectId: p.projectId,
      jobId: p.jobId,
      name: p.name,
      version: p.version,
      parentVersion: p.parentVersion,
      baseModel: p.baseModel,
      checkpointPath: p.checkpointPath,
      status: 'TRAINED',
      benchmarks: null,
      deployedAt: null,
      createdAt: p.createdAt,
    };
    this.models.set(model.id, model);
    this.modelByJob.set(model.jobId, model.id);
    if (!this.modelsByProject.has(model.projectId)) {
      this.modelsByProject.set(model.projectId, new Set());
    }
    this.modelsByProject.get(model.projectId)!.add(model.id);
  }

  private applyModelStatusUpdated(p: ModelStatusUpdatedPayload): void {
    const model = this.models.get(p.id);
    if (!model) return;
    model.status = p.status;
    if (p.benchmarks !== undefined) model.benchmarks = p.benchmarks;
    if (p.deployedAt !== undefined) model.deployedAt = p.deployedAt;
  }

  private applyDeploymentCreated(p: DeploymentCreatedPayload): void {
    const deployment: Deployment = {
      id: p.id,
      modelId: p.modelId,
      apiUrl: p.apiUrl,
      apiKey: p.apiKey,
      nimImagePath: p.nimImagePath,
      latencyMs: p.latencyMs,
      tokensPerSec: p.tokensPerSec,
      status: p.status,
      createdAt: p.createdAt,
    };
    this.deployments.set(deployment.id, deployment);
    this.deploymentByModel.set(deployment.modelId, deployment.id);
  }

  private applyDeploymentUpdated(p: DeploymentUpdatedPayload): void {
    const deployment = this.deployments.get(p.id);
    if (!deployment) return;
    Object.assign(deployment, p.updates);
  }

  private applyEvalResultCreated(p: EvalResultCreatedPayload): void {
    const evalResult: EvalResult = {
      id: p.id,
      modelId: p.modelId,
      benchmark: p.benchmark,
      score: p.score,
      metadata: p.metadata,
      createdAt: p.createdAt,
    };
    this.evalResults.set(evalResult.id, evalResult);
    if (!this.evalsByModel.has(evalResult.modelId)) {
      this.evalsByModel.set(evalResult.modelId, new Set());
    }
    this.evalsByModel.get(evalResult.modelId)!.add(evalResult.id);
  }

  private applyUsageRecorded(p: UsageRecordedPayload): void {
    const record: UsageRecord = {
      id: p.id,
      userId: p.userId,
      jobId: p.jobId,
      gpuHours: p.gpuHours,
      costUSD: p.costUSD,
      recordedAt: p.recordedAt,
    };
    this.usageRecords.set(record.id, record);
  }

  private applyGuardrailUpserted(p: GuardrailUpsertedPayload): void {
    const guardrail: Guardrail = {
      id: p.id,
      modelId: p.modelId,
      rules: p.rules,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
    const existingId = this.guardrailByModel.get(p.modelId);
    if (existingId) {
      this.guardrails.delete(existingId);
    }
    this.guardrails.set(guardrail.id, guardrail);
    this.guardrailByModel.set(guardrail.modelId, guardrail.id);
  }

  // ═══════════════════════════════════════════════════
  // PUBLIC API — Write Methods (append event + update Map)
  // ═══════════════════════════════════════════════════

  // ── Users ──────────────────────────────────────────

  async createUser(data: { email: string; name: string; passwordHash: string; role?: Role }): Promise<User> {
    this.ensureInitialized();

    if (this.usersByEmail.has(data.email)) {
      throw Object.assign(new Error('Email already registered'), { code: 'CONFLICT', status: 409 });
    }

    const payload: UserCreatedPayload = {
      id: generateId(),
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash,
      role: data.role || 'RESEARCHER',
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.USER_CREATED, payload as unknown as Record<string, unknown>);
    this.applyUserCreated(payload);

    return this.users.get(payload.id)!;
  }

  getUserById(id: string): User | undefined {
    return this.users.get(id);
  }

  getUserByEmail(email: string): User | undefined {
    const userId = this.usersByEmail.get(email);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  // ── Refresh Tokens ─────────────────────────────────

  async createRefreshToken(data: { token: string; userId: string; expiresAt: Date }): Promise<RefreshToken> {
    this.ensureInitialized();

    const payload: RefreshTokenCreatedPayload = {
      id: generateId(),
      token: data.token,
      userId: data.userId,
      expiresAt: data.expiresAt.toISOString(),
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.REFRESH_TOKEN_CREATED, payload as unknown as Record<string, unknown>);
    this.applyRefreshTokenCreated(payload);

    return this.refreshTokens.get(payload.id)!;
  }

  getRefreshTokenByToken(token: string): RefreshToken | undefined {
    const tokenId = this.refreshTokensByToken.get(token);
    if (!tokenId) return undefined;
    return this.refreshTokens.get(tokenId);
  }

  async markRefreshTokenUsed(tokenId: string): Promise<void> {
    this.ensureInitialized();
    const payload: RefreshTokenUsedPayload = { id: tokenId };
    await shrikdbClient.appendEvent(EVENT_TYPES.REFRESH_TOKEN_USED, payload as unknown as Record<string, unknown>);
    this.applyRefreshTokenUsed(payload);
  }

  async invalidateUserRefreshTokens(userId: string): Promise<void> {
    this.ensureInitialized();
    const payload: RefreshTokenInvalidatedPayload = { userId };
    await shrikdbClient.appendEvent(EVENT_TYPES.REFRESH_TOKEN_INVALIDATED, payload as unknown as Record<string, unknown>);
    this.applyRefreshTokenInvalidated(payload);
  }

  // ── Projects ───────────────────────────────────────

  async createProject(data: { name: string; userId: string }): Promise<Project> {
    this.ensureInitialized();

    const payload: ProjectCreatedPayload = {
      id: generateId(),
      name: data.name,
      userId: data.userId,
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.PROJECT_CREATED, payload as unknown as Record<string, unknown>);
    this.applyProjectCreated(payload);

    return this.projects.get(payload.id)!;
  }

  getProjectById(id: string): Project | undefined {
    return this.projects.get(id);
  }

  getProjectsByUser(userId: string): Project[] {
    const ids = this.projectsByUser.get(userId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.projects.get(id)!).filter(Boolean);
  }

  // ── Datasets ───────────────────────────────────────

  async createDataset(data: {
    projectId: string; fileName: string; fileType: string;
    minioPath: string; sampleCount: number; qualityScore: number;
  }): Promise<Dataset> {
    this.ensureInitialized();

    const payload: DatasetUploadedPayload = {
      id: generateId(),
      projectId: data.projectId,
      fileName: data.fileName,
      fileType: data.fileType,
      minioPath: data.minioPath,
      sampleCount: data.sampleCount,
      qualityScore: data.qualityScore,
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.DATASET_UPLOADED, payload as unknown as Record<string, unknown>);
    this.applyDatasetUploaded(payload);

    return this.datasets.get(payload.id)!;
  }

  getDatasetById(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  getDatasetsByProject(projectId: string): Dataset[] {
    const ids = this.datasetsByProject.get(projectId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.datasets.get(id)!).filter(Boolean);
  }

  async deleteDataset(id: string): Promise<void> {
    this.ensureInitialized();
    const dataset = this.datasets.get(id);
    if (!dataset) {
      throw Object.assign(new Error('Dataset not found'), { code: 'NOT_FOUND', status: 404 });
    }
    const payload: DatasetDeletedPayload = { id };
    await shrikdbClient.appendEvent(EVENT_TYPES.DATASET_DELETED, payload as unknown as Record<string, unknown>);
    this.applyDatasetDeleted(payload);
  }

  // ── Jobs ───────────────────────────────────────────

  async createJob(data: {
    projectId: string; datasetId: string; modelName: string;
    method?: string; hyperparams?: Record<string, unknown>; estimatedCost?: number;
  }): Promise<Job> {
    this.ensureInitialized();

    // Duplicate detection
    for (const [, job] of this.jobs) {
      if (
        job.datasetId === data.datasetId &&
        job.modelName === data.modelName &&
        (job.status === 'QUEUED' || job.status === 'RUNNING')
      ) {
        throw Object.assign(
          new Error(`Job already ${job.status} for this dataset + model combo`),
          { code: 'CONFLICT', status: 409, existingJobId: job.id }
        );
      }
    }

    const payload: JobCreatedPayload = {
      id: generateId(),
      projectId: data.projectId,
      datasetId: data.datasetId,
      modelName: data.modelName,
      method: data.method || 'finetune',
      hyperparams: data.hyperparams || {},
      estimatedCost: data.estimatedCost || null,
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.JOB_CREATED, payload as unknown as Record<string, unknown>);
    this.applyJobCreated(payload);

    return this.jobs.get(payload.id)!;
  }

  getJobById(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getJobsByProject(projectId: string): Job[] {
    const ids = this.jobsByProject.get(projectId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.jobs.get(id)!).filter(Boolean);
  }

  getJobByNemoId(nemoJobId: string): Job | undefined {
    const jobId = this.jobByNemoId.get(nemoJobId);
    if (!jobId) return undefined;
    return this.jobs.get(jobId);
  }

  async updateJobStatus(id: string, data: Omit<JobStatusUpdatedPayload, 'id'>): Promise<Job> {
    this.ensureInitialized();
    const payload: JobStatusUpdatedPayload = { id, ...data };
    await shrikdbClient.appendEvent(EVENT_TYPES.JOB_STATUS_UPDATED, payload as unknown as Record<string, unknown>);
    this.applyJobStatusUpdated(payload);
    return this.jobs.get(id)!;
  }

  async updateJobProgress(id: string, data: Omit<JobProgressUpdatedPayload, 'id'>): Promise<Job> {
    this.ensureInitialized();
    const payload: JobProgressUpdatedPayload = { id, ...data };
    await shrikdbClient.appendEvent(EVENT_TYPES.JOB_PROGRESS_UPDATED, payload as unknown as Record<string, unknown>);
    this.applyJobProgressUpdated(payload);
    return this.jobs.get(id)!;
  }

  // ── Models ─────────────────────────────────────────

  async createModel(data: {
    projectId: string; jobId: string; name: string; version?: string;
    parentVersion?: string; baseModel: string; checkpointPath?: string;
  }): Promise<Model> {
    this.ensureInitialized();

    // Ensure unique jobId → model mapping
    if (this.modelByJob.has(data.jobId)) {
      throw Object.assign(new Error('Model already exists for this job'), { code: 'CONFLICT', status: 409 });
    }

    const payload: ModelCreatedPayload = {
      id: generateId(),
      projectId: data.projectId,
      jobId: data.jobId,
      name: data.name,
      version: data.version || '1.0.0',
      parentVersion: data.parentVersion || null,
      baseModel: data.baseModel,
      checkpointPath: data.checkpointPath || null,
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.MODEL_CREATED, payload as unknown as Record<string, unknown>);
    this.applyModelCreated(payload);

    return this.models.get(payload.id)!;
  }

  getModelById(id: string): Model | undefined {
    return this.models.get(id);
  }

  getModelsByProject(projectId: string): Model[] {
    const ids = this.modelsByProject.get(projectId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.models.get(id)!).filter(Boolean);
  }

  getModelByJobId(jobId: string): Model | undefined {
    const modelId = this.modelByJob.get(jobId);
    if (!modelId) return undefined;
    return this.models.get(modelId);
  }

  async updateModelStatus(id: string, data: Omit<ModelStatusUpdatedPayload, 'id'>): Promise<Model> {
    this.ensureInitialized();
    const payload: ModelStatusUpdatedPayload = { id, ...data };
    await shrikdbClient.appendEvent(EVENT_TYPES.MODEL_STATUS_UPDATED, payload as unknown as Record<string, unknown>);
    this.applyModelStatusUpdated(payload);
    return this.models.get(id)!;
  }

  // ── Deployments ────────────────────────────────────

  async createDeployment(data: {
    modelId: string; apiUrl: string; apiKey: string;
    nimImagePath?: string; latencyMs?: number; tokensPerSec?: number; status?: string;
  }): Promise<Deployment> {
    this.ensureInitialized();

    if (this.deploymentByModel.has(data.modelId)) {
      throw Object.assign(new Error('Deployment already exists for this model'), { code: 'CONFLICT', status: 409 });
    }

    const payload: DeploymentCreatedPayload = {
      id: generateId(),
      modelId: data.modelId,
      apiUrl: data.apiUrl,
      apiKey: data.apiKey,
      nimImagePath: data.nimImagePath || null,
      latencyMs: data.latencyMs || null,
      tokensPerSec: data.tokensPerSec || null,
      status: data.status || 'deploying',
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.DEPLOYMENT_CREATED, payload as unknown as Record<string, unknown>);
    this.applyDeploymentCreated(payload);

    return this.deployments.get(payload.id)!;
  }

  getDeploymentById(id: string): Deployment | undefined {
    return this.deployments.get(id);
  }

  getDeploymentByModelId(modelId: string): Deployment | undefined {
    const deploymentId = this.deploymentByModel.get(modelId);
    if (!deploymentId) return undefined;
    return this.deployments.get(deploymentId);
  }

  getAllDeployments(): Deployment[] {
    return Array.from(this.deployments.values());
  }

  async updateDeployment(id: string, updates: Partial<Pick<Deployment, 'status' | 'latencyMs' | 'tokensPerSec' | 'apiUrl'>>): Promise<Deployment> {
    this.ensureInitialized();
    const payload: DeploymentUpdatedPayload = { id, updates };
    await shrikdbClient.appendEvent(EVENT_TYPES.DEPLOYMENT_UPDATED, payload as unknown as Record<string, unknown>);
    this.applyDeploymentUpdated(payload);
    return this.deployments.get(id)!;
  }

  // ── Eval Results ───────────────────────────────────

  async createEvalResult(data: {
    modelId: string; benchmark: string; score: number;
    metadata?: Record<string, unknown>;
  }): Promise<EvalResult> {
    this.ensureInitialized();

    const payload: EvalResultCreatedPayload = {
      id: generateId(),
      modelId: data.modelId,
      benchmark: data.benchmark,
      score: data.score,
      metadata: data.metadata || null,
      createdAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.EVAL_RESULT_CREATED, payload as unknown as Record<string, unknown>);
    this.applyEvalResultCreated(payload);

    return this.evalResults.get(payload.id)!;
  }

  getEvalResultsByModel(modelId: string): EvalResult[] {
    const ids = this.evalsByModel.get(modelId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.evalResults.get(id)!).filter(Boolean);
  }

  // ── Usage Records ──────────────────────────────────

  async recordUsage(data: {
    userId: string; jobId?: string; gpuHours: number; costUSD: number;
  }): Promise<UsageRecord> {
    this.ensureInitialized();

    const payload: UsageRecordedPayload = {
      id: generateId(),
      userId: data.userId,
      jobId: data.jobId || null,
      gpuHours: data.gpuHours,
      costUSD: data.costUSD,
      recordedAt: nowISO(),
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.USAGE_RECORDED, payload as unknown as Record<string, unknown>);
    this.applyUsageRecorded(payload);

    return this.usageRecords.get(payload.id)!;
  }

  // ── Guardrails ─────────────────────────────────────

  async upsertGuardrail(data: { modelId: string; rules: Record<string, unknown> }): Promise<Guardrail> {
    this.ensureInitialized();

    const existingId = this.guardrailByModel.get(data.modelId);
    const now = nowISO();

    const payload: GuardrailUpsertedPayload = {
      id: existingId || generateId(),
      modelId: data.modelId,
      rules: data.rules,
      createdAt: existingId ? this.guardrails.get(existingId)!.createdAt : now,
      updatedAt: now,
    };

    await shrikdbClient.appendEvent(EVENT_TYPES.GUARDRAIL_UPSERTED, payload as unknown as Record<string, unknown>);
    this.applyGuardrailUpserted(payload);

    return this.guardrails.get(payload.id)!;
  }

  getGuardrailByModel(modelId: string): Guardrail | undefined {
    const id = this.guardrailByModel.get(modelId);
    if (!id) return undefined;
    return this.guardrails.get(id);
  }

  // ── Metrics ────────────────────────────────────────

  getStats(): Record<string, number> {
    return {
      users: this.users.size,
      projects: this.projects.size,
      datasets: this.datasets.size,
      jobs: this.jobs.size,
      models: this.models.size,
      deployments: this.deployments.size,
      evalResults: this.evalResults.size,
      usageRecords: this.usageRecords.size,
      guardrails: this.guardrails.size,
      totalEvents: this.eventCount,
    };
  }
}

// ── Singleton Export ────────────────────────────────────

export const stateStore = new StateStore();
