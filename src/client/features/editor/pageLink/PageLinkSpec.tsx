import { createReactInlineContentSpec } from '@blocknote/react';
import { PageLinkChip } from './PageLinkChip.tsx';

/** `@` mention of another page: stores the id and a title snapshot; renders live title/icon from the tree. */
export const pageLinkSpec = createReactInlineContentSpec(
  { type: 'pageLink', propSchema: { pageId: { default: '' }, title: { default: '' } }, content: 'none' },
  { render: props => <PageLinkChip pageId={props.inlineContent.props.pageId} title={props.inlineContent.props.title} /> },
);
