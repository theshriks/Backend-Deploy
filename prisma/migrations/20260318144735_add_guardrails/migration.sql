-- CreateTable
CREATE TABLE "guardrails" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guardrails_modelId_idx" ON "guardrails"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "guardrails_modelId_key" ON "guardrails"("modelId");

-- AddForeignKey
ALTER TABLE "guardrails" ADD CONSTRAINT "guardrails_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
