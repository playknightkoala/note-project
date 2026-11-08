import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from '@blocknote/core';
import { pageLinkSpec } from './pageLink/PageLinkSpec.tsx';

/** Full default BlockNote schema plus the `pageLink` inline mention. */
export const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink: pageLinkSpec },
  styleSpecs: defaultStyleSpecs,
});

export type AppEditor = typeof schema.BlockNoteEditor;
