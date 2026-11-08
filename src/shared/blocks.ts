// Minimal structural model of BlockNote block JSON. The server stores blocks as-is; it only validates shape and size.
import { z } from 'zod';
import { newId } from './ids.ts';

export interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children: Block[];
}

export const MAX_BLOCK_DEPTH = 20;
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const blockSchema: z.ZodType<Block> = z.lazy(() => z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  props: z.record(z.string(), z.unknown()).default({}),
  content: z.unknown().optional(),
  children: z.array(blockSchema).default([]),
})) as unknown as z.ZodType<Block>;

export const blocksSchema = z.array(blockSchema).max(20_000);

export function blockDepth(blocks: Block[], depth = 1): number {
  let max = blocks.length ? depth : 0;
  for (const block of blocks) if (block.children.length) max = Math.max(max, blockDepth(block.children, depth + 1));
  return max;
}

/** Validates blocks for storage: structure, nesting depth and serialized size. Returns the normalized array. */
export function parseBlocks(value: unknown): { blocks: Block[]; json: string } | { error: string } {
  const result = blocksSchema.safeParse(value);
  if (!result.success) return { error: '區塊格式不正確。' };
  if (blockDepth(result.data) > MAX_BLOCK_DEPTH) return { error: `區塊巢狀超過 ${MAX_BLOCK_DEPTH} 層。` };
  const json = JSON.stringify(result.data);
  if (json.length > MAX_CONTENT_BYTES) return { error: '頁面內容超過 2 MB。' };
  return { blocks: result.data, json };
}

export const emptyParagraph = (): Block => ({ id: newId(), type: 'paragraph', props: {}, content: [], children: [] });
