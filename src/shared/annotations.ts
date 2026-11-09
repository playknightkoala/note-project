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
export interface AnnotationMessage { id: string; text: string; createdAt: number }
export interface Annotation {
  id: string; quote: string; blockIds: string[]; messages: AnnotationMessage[];
  reactions: string[]; resolved: boolean; version: number; createdAt: number; updatedAt: number;
}

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
