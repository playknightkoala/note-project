import { useEffect } from 'react';
import { filterSuggestionItems } from '@blocknote/core';
import type { PartialBlock } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { EmojiPickerController, SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from '@blocknote/react';
import { useComputedColorScheme } from '@mantine/core';
import { useNavigate } from 'react-router';
import { dictionary } from './dictionary.ts';
import { useImeGuard } from './imeGuard.ts';
import { schema } from './schema.ts';
import type { AppEditor } from './schema.ts';
import { usePageMentionItems } from './pageLink/usePageMentionItems.ts';
import { slashItems } from './slashItems.ts';

export interface BlockEditorProps {
  pageId: string;
  initialContent: PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[];
  onReady: (editor: AppEditor, isComposing: () => boolean) => void;
  /** Called after every document change that happens outside an IME composition. */
  onChange: () => void;
  /** Fires when a composition finished (the pending change can now be serialized). */
  onCompositionSettled: () => void;
  uploadFile?: (file: File) => Promise<string>;
  fullWidth?: boolean;
}

export function BlockEditor({ pageId, initialContent, onReady, onChange, onCompositionSettled, uploadFile, fullWidth }: BlockEditorProps) {
  const scheme = useComputedColorScheme('light');
  const navigate = useNavigate();
  const ime = useImeGuard(onCompositionSettled);
  const editor = useCreateBlockNote({
    schema, dictionary, animations: true, trailingBlock: true, tabBehavior: 'prefer-indent',
    ...(initialContent.length ? { initialContent } : {}),
    ...(uploadFile ? { uploadFile } : {}),
    links: {
      onClick: event => {
        const href = (event.target as HTMLAnchorElement | null)?.closest('a')?.getAttribute('href') ?? '';
        if (href.startsWith('/p/')) { event.preventDefault(); navigate(href); return false; }
        window.open(href, '_blank', 'noopener');
        return false;
      },
    },
  }, [pageId]);
  useEffect(() => { onReady(editor, () => ime.composing.current); }, [editor, onReady, ime.composing]);
  const mentionItems = usePageMentionItems(editor, pageId);
  return <div className={`block-editor${fullWidth ? ' block-editor--full' : ''}`} {...ime.wrapperProps}>
    <BlockNoteView editor={editor} theme={scheme} slashMenu={false} emojiPicker={false}
      onChange={() => { if (!ime.composing.current) onChange(); }}>
      <SuggestionMenuController triggerCharacter="/" shouldOpen={ime.notComposing}
        getItems={async query => filterSuggestionItems([...slashItems(editor, pageId, navigate), ...getDefaultReactSlashMenuItems(editor)], query)} />
      <SuggestionMenuController triggerCharacter="@" shouldOpen={ime.notComposing} minQueryLength={0} getItems={mentionItems} />
      <EmojiPickerController triggerCharacter=":" shouldOpen={ime.notComposing} minQueryLength={2} />
    </BlockNoteView>
  </div>;
}
