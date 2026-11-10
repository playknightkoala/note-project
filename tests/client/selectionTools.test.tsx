// @vitest-environment jsdom
import type { ComponentType } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockNoteEditor } from '@blocknote/core';
import { api, ApiError } from '../../src/client/api/client.ts';
import type { Annotation } from '../../src/shared/annotations.ts';
import type { OfflineOp } from '../../src/shared/offline.ts';
import { schema } from '../../src/client/features/editor/schema.ts';
import { SelectionTools } from '../../src/client/features/editor/SelectionTools.tsx';

vi.mock('../../src/client/api/client.ts', async importOriginal => ({ ...await importOriginal<object>(), api: vi.fn() }));
vi.mock('../../src/client/api/auth.ts', () => ({ useMe: () => ({ data: { id: 'owner' } }) }));
vi.mock('@blocknote/react', async importOriginal => ({ ...await importOriginal<object>(), DesktopFormattingToolbarController: ({ formattingToolbar: Toolbar }: { formattingToolbar: ComponentType }) => <Toolbar /> }));
vi.mock('../../src/client/features/editor/SelectionToolbar.tsx', () => ({ SelectionToolbar: ({ onAnnotate }: { onAnnotate: (mode: 'reaction') => void }) => <button onClick={() => onAnnotate('reaction')}>加表情反應</button> }));
let editor: typeof schema.BlockNoteEditor; let client: QueryClient;
const annotation: Annotation = { id: 'annotation-example', quote: '原文', blockIds: ['b'], messages: [{ id: 'm', text: '原留言', createdAt: 1 }], reactions: [], resolved: false, version: 1, createdAt: 1, updatedAt: 1 };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  editor = BlockNoteEditor.create({ schema });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['annotations', 'owner', 'page-example'], { annotations: [annotation] });
  vi.mocked(api).mockImplementation(async method => {
    if (method === 'GET') return { annotations: [annotation] } as never;
    return { annotation: { ...annotation, version: 2, reactions: ['👍'] } } as never;
  });
});
/** The operations sent so far. Every change to a discussion is one repeatable operation with ids chosen by the client. */
const sentOps = () => vi.mocked(api).mock.calls.filter(([method, path]) => method === 'POST' && path === '/api/offline/ops').map(([, , options]) => (options!.json as { op: OfflineOp }).op);
afterEach(() => { cleanup(); client.clear(); editor._tiptapEditor.destroy(); Reflect.deleteProperty(document, 'fonts'); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function openReply() {
  render(<MantineProvider env="test"><QueryClientProvider client={client}><SelectionTools editor={editor} pageId="page-example" /></QueryClientProvider></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '留言與反應 1' }));
  fireEvent.click(screen.getByRole('button', { name: /原文.*1 則留言/ }));
  fireEvent.change(screen.getByLabelText('回覆留言'), { target: { value: '未送出的草稿' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '送出留言' }).hasAttribute('disabled')).toBe(false));
}

it('keeps a reply draft when adding an emoji reaction', async () => {
  await openReply();
  fireEvent.click(screen.getByRole('button', { name: '反應 👍' }));
  await screen.findByRole('button', { name: '移除反應 👍' });
  expect((screen.getByLabelText('回覆留言') as HTMLTextAreaElement).value).toBe('未送出的草稿');
});

it('lets the user cancel and then confirm deletion of a saved discussion', async () => {
  await openReply();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: '刪除整則討論' }));
  expect(sentOps()).toEqual([]);
  confirm.mockReturnValue(true);
  vi.mocked(api).mockImplementation(async method => method === 'POST' ? { deletedId: annotation.id } as never : { annotations: [] } as never);
  fireEvent.click(screen.getByRole('button', { name: '刪除整則討論' }));
  // The deletion says how many comments were on screen, so a reply this device has not seen is not deleted with it.
  await waitFor(() => expect(sentOps()).toEqual([{ type: 'annotation.delete', pageId: 'page-example', annotationId: annotation.id, messages: 1 }]));
  await waitFor(() => expect(screen.queryByText('原留言')).toBeNull());
  confirm.mockRestore();
});

it('retains comments and the reply draft when the deletion is refused', async () => {
  editor.replaceBlocks(editor.document, [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: '原文', styles: { annotation: annotation.id } }] }]);
  const content = JSON.stringify(editor.document);
  await openReply();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api).mockImplementation(async method => {
    if (method === 'GET') return { annotations: [{ ...annotation, version: 2 }] } as never;
    throw new ApiError(409, 'version_conflict', '留言已在其他分頁更新，請重新載入後再試。');
  });
  fireEvent.click(screen.getByRole('button', { name: '刪除整則討論' }));
  await screen.findByRole('alert');
  expect(screen.getByText('原留言')).toBeTruthy();
  expect((screen.getByLabelText('回覆留言') as HTMLTextAreaElement).value).toBe('未送出的草稿');
  expect(JSON.stringify(editor.document)).toBe(content);
  confirm.mockRestore();
});

it('keeps a rejected reply draft and reports why it was refused', async () => {
  await openReply();
  vi.mocked(api).mockImplementation(async method => {
    if (method === 'GET') return { annotations: [{ ...annotation, version: 2 }] } as never;
    throw new ApiError(409, 'version_conflict', '留言已在其他分頁更新，請重新載入後再試。');
  });
  fireEvent.click(screen.getByRole('button', { name: '送出留言' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('回覆留言') as HTMLTextAreaElement).value).toBe('未送出的草稿');
  expect(screen.getByText('留言已在其他分頁更新，請重新載入後再試。')).toBeTruthy();
});

it('reuses the existing discussion when reacting to the same marked text again', async () => {
  editor.replaceBlocks(editor.document, [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: '原文', styles: { annotation: annotation.id } }] }, { id: 'c', type: 'paragraph', content: [] }]);
  editor.setSelection('b', 'c');
  render(<MantineProvider env="test"><QueryClientProvider client={client}><SelectionTools editor={editor} pageId="page-example" /></QueryClientProvider></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '加表情反應' }));
  expect(screen.getByText('原留言')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '反應 👍' }));
  await screen.findByRole('button', { name: '移除反應 👍' });
  // A reaction says whether it is switched on or off, so sending it twice cannot toggle it back.
  expect(sentOps()).toEqual([{ type: 'annotation.reaction', pageId: 'page-example', annotationId: annotation.id, emoji: '👍', on: true }]);
});

it('opens a discussion by clicking its text after the editor mounts', async () => {
  editor.replaceBlocks(editor.document, [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: '原文', styles: { annotation: annotation.id } }] }, { id: 'c', type: 'paragraph', content: [] }]);
  render(<MantineProvider env="test"><QueryClientProvider client={client}><SelectionTools editor={editor} pageId="page-example" /></QueryClientProvider></MantineProvider>);
  const host = document.createElement('div'); document.body.append(host); editor.mount(host);
  editor.setSelection('b', 'c');
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  expect(fireEvent.contextMenu(host.querySelector('[data-annotation-ids]')!)).toBe(false);
  expect(fireEvent.contextMenu(host.querySelector('[data-annotation-ids]')!, { shiftKey: true })).toBe(true);
  fireEvent.click(host.querySelector('[data-annotation-ids]')!);
  await screen.findByText('原留言');
  editor.unmount(); host.remove();
});

it('lets a reader without edit access comment without touching the page: the discussion is shown by its quote', async () => {
  const host = document.createElement('div'); document.body.append(host); editor.mount(host);
  editor.replaceBlocks(editor.document, [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: '可以留言的原文', styles: { bold: true } }] }, { id: 'c', type: 'paragraph', content: '另一段可以留言' }]);
  const stored = JSON.stringify(editor.document);
  editor.isEditable = false;
  Range.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 24, left: 12, right: 80, width: 68, height: 14, x: 12, y: 10, toJSON: () => ({}) });
  client.setQueryData(['annotations', 'owner', 'page-example'], { annotations: [] });
  vi.mocked(api).mockImplementation(async (method, _path, options) => {
    if (method === 'GET') return { annotations: [] } as never;
    const op = (options!.json as { op: Extract<OfflineOp, { type: 'annotation.create' }> }).op;
    return { annotation: { ...annotation, id: op.annotationId, quote: op.quote, blockIds: op.blockIds, floating: true, messages: [{ id: op.messageId, text: op.text, createdAt: 1 }] } } as never;
  });
  render(<MantineProvider env="test"><QueryClientProvider client={client}><SelectionTools editor={editor} pageId="page-example" readOnly /></QueryClientProvider></MantineProvider>);
  // Nothing is offered until text is selected.
  expect(screen.queryByRole('toolbar', { name: '選取文字工具' })).toBeNull();
  const text = [...host.querySelectorAll('.bn-inline-content *, .bn-inline-content')].flatMap(node => [...node.childNodes]).find(node => node.nodeType === Node.TEXT_NODE && node.textContent === '可以留言的原文')!;
  window.getSelection()!.setBaseAndExtent(text, 0, text, 4);
  document.dispatchEvent(new Event('selectionchange'));
  fireEvent.click(within(await screen.findByRole('toolbar', { name: '選取文字工具' })).getByRole('button', { name: '留言' }));
  fireEvent.change(await screen.findByLabelText('留言'), { target: { value: '讀者的留言' } });
  fireEvent.click(screen.getByRole('button', { name: '送出留言' }));
  await waitFor(() => expect(sentOps()).toHaveLength(1));
  const op = sentOps()[0] as Extract<OfflineOp, { type: 'annotation.create' }>;
  // Only the discussion is sent: a quote and the blocks it is in, nothing of the page.
  expect(op).toEqual({ type: 'annotation.create', pageId: 'page-example', annotationId: op.annotationId, messageId: op.messageId, quote: '可以留言', blockIds: ['b'], text: '讀者的留言', at: op.at, floating: true });
  expect(JSON.stringify(editor.document)).toBe(stored);
  // The quote is highlighted where it stands in the commented block (not the same words in another block), and
  // leads to the discussion.
  await waitFor(() => expect([...host.querySelectorAll('.annotation-highlight')].map(node => node.textContent)).toEqual(['可以留言']));
  expect(host.querySelector('.annotation-highlight')?.getAttribute('data-annotation-ids')).toBe(op.annotationId);
  host.remove();
});
