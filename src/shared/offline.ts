import { z } from 'zod';
import { pageIdSchema } from './api.ts';

/** A durable operation id makes retries safe even if the first response was lost. */
export const syncNoteSchema = z.object({
  operationId: z.string().uuid(),
  baseVersion: z.number().int().min(0).nullable(),
  baseTitle: z.string().max(500),
  title: z.string().max(500),
  parentId: pageIdSchema.nullable(),
  content: z.array(z.unknown()).max(20_000),
  overwrite: z.boolean().default(false),
});
export type SyncNoteInput = z.infer<typeof syncNoteSchema>;
