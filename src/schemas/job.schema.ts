import { z } from 'zod';

export const trainJobSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  datasetId: z.string().uuid('Invalid dataset ID'),
  modelName: z.string().min(1, 'Model name is required').max(100),
  method: z.enum(['finetune', 'qlora', 'rlhf', 'rlaif']).default('finetune'),
  hyperparams: z
    .object({
      epochs: z.number().int().min(1).max(100).optional(),
      batchSize: z.number().int().min(1).max(256).optional(),
      learningRate: z.number().positive().optional(),
    })
    .optional()
    .default({}),
});

export type TrainJobInput = z.infer<typeof trainJobSchema>;
