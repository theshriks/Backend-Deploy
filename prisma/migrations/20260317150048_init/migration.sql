-- CreateEnum
CREATE TYPE "Role" AS ENUM ('RESEARCHER', 'SAFETY_ADMIN', 'COMPLIANCE', 'EXECUTIVE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('TRAINED', 'EVALUATING', 'EVALUATED', 'DEPLOYING', 'DEPLOYED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'RESEARCHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "minioPath" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'finetune',
    "hyperparams" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentLoss" DOUBLE PRECISION,
    "currentStep" INTEGER,
    "totalSteps" INTEGER,
    "eta" TEXT,
    "estimatedCost" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "nemoJobId" TEXT,
    "checkpointPath" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "parentVersion" TEXT,
    "baseModel" TEXT NOT NULL,
    "checkpointPath" TEXT,
    "status" "ModelStatus" NOT NULL DEFAULT 'TRAINED',
    "benchmarks" JSONB,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "nimImagePath" TEXT,
    "latencyMs" DOUBLE PRECISION,
    "tokensPerSec" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'deploying',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "benchmark" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "gpuHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_token_idx" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "Dataset_projectId_idx" ON "Dataset"("projectId");

-- CreateIndex
CREATE INDEX "Job_projectId_idx" ON "Job"("projectId");

-- CreateIndex
CREATE INDEX "Job_datasetId_idx" ON "Job"("datasetId");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Model_jobId_key" ON "Model"("jobId");

-- CreateIndex
CREATE INDEX "Model_projectId_idx" ON "Model"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_modelId_key" ON "Deployment"("modelId");

-- CreateIndex
CREATE INDEX "EvalResult_modelId_idx" ON "EvalResult"("modelId");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_idx" ON "UsageRecord"("userId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
