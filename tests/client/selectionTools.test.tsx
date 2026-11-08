// @vitest-environment jsdom
import type { ComponentType } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockNoteEditor } from '@blocknote/core';
import { api, ApiError } from '../../src/client/api/client.ts';
import type { Annotation } from '../../src/shared/annotations.ts';
import { schema } from '../../src/client/features/editor/schema.ts';
import { SelectionTools } from '../../src/client/features/editor/SelectionTools.tsx';

vi.mock('../../src/client/api/client.ts', async importOriginal => ({ ...await importOriginal<object>(), api: vi.fn() }));
vi.mock('../../src/client/api/auth.ts', () => ({ useMe: () => ({ data: { id: 'owner' } }) }));
vi.mock('@blocknote/react', async importOriginal => ({ ...await importOriginal<object>(), FormattingToolbarController: ({ formattingToolbar: Toolbar }: { formattingToolbar: ComponentType }) => <Toolbar /> }));
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

it('keeps a rejected reply draft and reports a version conflict', async () => {
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
  expect(vi.mocked(api).mock.calls.some(([method, path]) => method === 'PATCH' && path.endsWith(`/${annotation.id}`))).toBe(true);
  expect(vi.mocked(api).mock.calls.some(([method]) => method === 'POST')).toBe(false);
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
