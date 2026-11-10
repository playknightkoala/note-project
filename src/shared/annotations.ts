import { z } from 'zod';

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '😄', '🤔', '👀', '✅', '🚀', '🙏', '💡', '🔥', '😢'] as const;
export const reactionSchema = z.string().min(1).max(32)
  .regex(/^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u, '請選擇表情符號。')
  .refine(value => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value), '請選擇表情符號。');
const message = z.string().trim().min(1).max(4000);
export const createAnnotationSchema = z.object({
  quote: z.string().trim().min(1).max(8000),
  blockIds: z.array(z.string().min(1).max(64)).min(1).max(100),
  text: message.optional(), emoji: reactionSchema.optional(),
}).refine(input => input.text !== undefined || input.emoji !== undefined, '請輸入留言或選擇表情符號。');
export const changeAnnotationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('comment'), text: message }),
  z.object({ action: z.literal('reaction'), emoji: reactionSchema }),
  z.object({ action: z.literal('resolve'), resolved: z.boolean() }),
]);
export type CreateAnnotation = z.infer<typeof createAnnotationSchema>;
export type ChangeAnnotation = z.infer<typeof changeAnnotationSchema>;
export interface AnnotationAuthor { id: string; name: string }
export interface AnnotationMessage { id: string; text: string; createdAt: number; author?: AnnotationAuthor }
/**
 * `reactions` lists every emoji anyone put on the discussion. The fields after `updatedAt` are computed for the
 * reader and may be missing on a copy a device stored before pages could be shared: such a copy is always of the
 * reader's own page, where every reaction is theirs and they may delete the discussion.
 */
export interface Annotation {
  id: string; quote: string; blockIds: string[]; messages: AnnotationMessage[];
  reactions: string[]; resolved: boolean; version: number; createdAt: number; updatedAt: number;
  author?: AnnotationAuthor; mine?: string[]; counts?: Record<string, number>; canDelete?: boolean;
  /**
   * Started by someone who may not write the page, so the text carries no mark. Readers highlight the quote where
   * it is still found in the commented blocks; nothing of the page is changed by such a discussion.
   */
  floating?: boolean;
}
export const myReactions = (annotation: Annotation): string[] => annotation.mine ?? annotation.reactions;
export const reactionCount = (annotation: Annotation, emoji: string): number => annotation.counts?.[emoji] ?? 1;

/** An empty reaction-only discussion no longer highlights any text. */
export const isActiveAnnotation = (annotation: Annotation): boolean => !annotation.resolved && (annotation.messages.length > 0 || annotation.reactions.length > 0);

/** Duplicated pages start a new discussion; do not retain links to the source's annotations. */
export function stripAnnotationAnchors(content: unknown[]): unknown[] {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      key === 'styles' && child && typeof child === 'object' && !Array.isArray(child)
        ? walk(Object.fromEntries(Object.entries(child).filter(([style]) => style !== 'annotation'))) : walk(child)]));
  };
  return content.map(walk);
}
