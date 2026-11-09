import { z } from 'zod';
import { pageIdSchema } from './api.ts';
import type { PageResponse, PageNode } from './api.ts';

/** Content versions plus all metadata (including ancestor names) used by an offline copy. */
export function summarizePage(response: PageResponse) {
  const { content: _content, ...page } = response.page;
  return { page, breadcrumbs: response.breadcrumbs };
}
export interface OfflineManifest {
  userId: string;
  tree: PageNode[];
  pages: ReturnType<typeof summarizePage>[];
  maxUploadBytes: number;
}

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
