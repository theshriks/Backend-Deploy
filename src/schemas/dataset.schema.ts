import { z } from 'zod';

export const datasetUploadSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

export const datasetListSchema = z.object({
  projectId: z.string().uuid('Invalid project ID').optional(),
});

export type DatasetUploadInput = z.infer<typeof datasetUploadSchema>;
export type DatasetListInput = z.infer<typeof datasetListSchema>;
