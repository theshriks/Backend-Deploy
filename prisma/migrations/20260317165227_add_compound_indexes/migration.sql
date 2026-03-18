-- CreateIndex
CREATE INDEX "EvalResult_modelId_benchmark_idx" ON "EvalResult"("modelId", "benchmark");

-- CreateIndex
CREATE INDEX "Job_projectId_status_idx" ON "Job"("projectId", "status");

-- CreateIndex
CREATE INDEX "Job_nemoJobId_idx" ON "Job"("nemoJobId");

-- CreateIndex
CREATE INDEX "Model_projectId_status_idx" ON "Model"("projectId", "status");
