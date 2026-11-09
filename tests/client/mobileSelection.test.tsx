// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { FormattingToolbarExtension } from '@blocknote/core/extensions';
import { SelectionTools } from '../../src/client/features/editor/SelectionTools.tsx';
import { schema } from '../../src/client/features/editor/schema.ts';
import { dictionary } from '../../src/client/features/editor/dictionary.ts';
import { api } from '../../src/client/api/client.ts';

vi.mock('../../src/client/api/client.ts', async importOriginal => ({ ...await importOriginal<object>(), api: vi.fn() }));
vi.mock('../../src/client/api/auth.ts', () => ({ useMe: () => ({ data: { id: 'synthetic-owner' } }) }));
let editor: typeof schema.BlockNoteEditor; let client: QueryClient; let mobile: boolean;
class TestViewport extends EventTarget {
  offsetTop = 0; offsetLeft = 0; width = 390; height = 800; scale = 1;
}
let viewport: TestViewport;
let viewportMeta: HTMLMetaElement;

beforeEach(() => {
  viewportMeta = document.createElement('meta'); viewportMeta.name = 'viewport'; viewportMeta.content = 'width=device-width, initial-scale=1, interactive-widget=resizes-content'; document.head.append(viewportMeta);
  mobile = true; viewport = new TestViewport();
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 767px') || query.includes('pointer: coarse') ? mobile : query.includes('pointer: fine') && !mobile, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('scrollBy', vi.fn());
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  Range.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 20, right: 80, x: 20, y: 100, width: 60, height: 20, toJSON() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Element.prototype.scrollIntoView = vi.fn();
  editor = BlockNoteEditor.create({ schema, dictionary, initialContent: [
    { id: 'first', type: 'paragraph', content: '第一段文字' },
    { id: 'second', type: 'paragraph', content: '第二段文字' },
    { id: 'other', type: 'paragraph', content: '其他段落' },
  ] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api).mockResolvedValue({ annotations: [] });
});
afterEach(() => { cleanup(); client.clear(); editor._tiptapEditor.destroy(); viewportMeta.remove(); Reflect.deleteProperty(document, 'fonts'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(composing = false) {
  const view = (composing: boolean) => <MantineProvider env="test"><QueryClientProvider client={client}><BlockNoteView editor={editor} formattingToolbar={false} slashMenu={false} emojiPicker={false} sideMenu={false} linkToolbar={false}><SelectionTools editor={editor} pageId="synthetic-page" composing={composing} /></BlockNoteView></QueryClientProvider></MantineProvider>;
  const result = render(view(composing));
  return { ...result, compose: (value: boolean) => result.rerender(view(value)) };
}
async function focusAndSelect() {
  await act(async () => { editor.focus(); editor.setSelection('first', 'second'); });
  await screen.findByRole('button', { name: '開啟格式與段落' });
}
async function openMobile() {
  fireEvent.click(screen.getByRole('button', { name: '開啟格式與段落' }));
  return screen.findByRole('dialog', { name: '格式與段落' });
}

it('leaves native touch selection alone and never opens the desktop panel on focus, selection or keyboard resize', async () => {
  mount(); await focusAndSelect();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('文字選取工具')).toBeNull();
  expect(document.querySelector('.bn-mobile-formatting-toolbar')).toBeNull();
  expect(fireEvent.contextMenu(editor.domElement!)).toBe(true);
  await act(async () => { viewport.height = 400; viewport.dispatchEvent(new Event('resize')); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('手機編輯工具').style.getPropertyValue('--selection-vv-height')).toBe('400px');
});

it('keeps the explicitly opened mobile paragraph picker alive after keyboard/focus changes and converts the original paragraphs', async () => {
  mount(); await focusAndSelect(); await openMobile();
  fireEvent.click(screen.getByRole('button', { name: '轉換段落類型' }));
  await screen.findByRole('dialog', { name: '轉換段落類型' });
  // A modal's focus handoff must not replace the saved editor range with a later caret position.
  await act(async () => { editor.setTextCursorPosition('other', 'start'); editor.blur(); viewport.height = 800; viewport.dispatchEvent(new Event('resize')); });
  expect(screen.getByRole('dialog', { name: '轉換段落類型' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: dictionary.slash_menu.heading_2.title }));
  await screen.findByRole('dialog', { name: '格式與段落' });
  expect(editor.document.map(block => block.type)).toEqual(['heading', 'heading', 'paragraph']);
  expect(editor.document[0]!.props).toMatchObject({ level: 2 });
  expect(editor.document[1]!.props).toMatchObject({ level: 2 });
  fireEvent.click(screen.getByRole('button', { name: '粗體' }));
  expect(JSON.stringify(editor.document[0]!.content)).toContain('"bold":true');
  expect(JSON.stringify(editor.document[1]!.content)).toContain('"bold":true');
  expect(JSON.stringify(editor.document[2]!.content)).not.toContain('"bold":true');
});

it('preserves formatting and annotation ranges when operating mobile controls and handing off to comments', async () => {
  mount(); await focusAndSelect(); await openMobile();
  fireEvent.click(screen.getByRole('button', { name: '粗體' }));
  fireEvent.click(screen.getByRole('button', { name: '斜體' }));
  expect(JSON.stringify(editor.document[0]!.content)).toContain('"bold":true');
  expect(JSON.stringify(editor.document[0]!.content)).toContain('"italic":true');
  expect(JSON.stringify(editor.document[2]!.content)).not.toContain('"bold":true');
  fireEvent.click(screen.getByRole('button', { name: '留言' }));
  const comments = await screen.findByRole('dialog', { name: '留言與表情反應' });
  expect(within(comments).getByRole('blockquote').textContent).toContain('第一段文字');
  expect(within(comments).getByRole('blockquote').textContent).toContain('第二段文字');
  expect(screen.queryByRole('dialog', { name: '格式與段落' })).toBeNull();
});

it('retains multiple typing styles at a caret and hides the dock while IME composition is active', async () => {
  const view = mount();
  await act(async () => { editor.setTextCursorPosition('first', 'end'); editor.focus(); });
  await screen.findByRole('button', { name: '開啟格式與段落' });
  view.compose(true);
  expect(screen.queryByRole('button', { name: '開啟格式與段落' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  view.compose(false); await openMobile();
  fireEvent.click(screen.getByRole('button', { name: '粗體' }));
  fireEvent.click(screen.getByRole('button', { name: '斜體' }));
  expect(editor.getActiveStyles()).toMatchObject({ bold: true, italic: true });
  fireEvent.click(screen.getByRole('button', { name: '關閉格式面板' }));
  await waitFor(() => expect(editor.isFocused()).toBe(true));
  expect(editor.getActiveStyles()).toMatchObject({ bold: true, italic: true });
});

it('moves the caret above the dock when the keyboard shrinks the viewport and follows viewport offsets', async () => {
  mount(); await focusAndSelect();
  const dock = screen.getByLabelText('手機編輯工具');
  vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 304, top: 304, bottom: 360, left: 0, right: 390, width: 390, height: 56, toJSON() {} });
  vi.spyOn(editor.prosemirrorView, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 400, bottom: 420 });
  await act(async () => { viewport.height = 360; viewport.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(window.scrollBy).toHaveBeenCalledWith({ top: 128, behavior: 'instant' }));
  await act(async () => { viewport.offsetTop = 20; viewport.width = 844; viewport.height = 340; viewport.dispatchEvent(new Event('scroll')); });
  expect(dock.style.getPropertyValue('--selection-vv-top')).toBe('20px');
  expect(dock.style.getPropertyValue('--selection-vv-width')).toBe('844px');
  expect(dock.style.getPropertyValue('--selection-vv-height')).toBe('340px');
});

it('preserves the saved text range across color/link inputs and clears presentation without removing annotations', async () => {
  editor.updateBlock('first', { content: [{ type: 'text', text: '第一段文字', styles: { bold: true, annotation: 'synthetic-annotation' } }] });
  mount(); await focusAndSelect(); await openMobile();
  fireEvent.click(screen.getByRole('button', { name: '顏色' }));
  fireEvent.click(screen.getByRole('combobox', { name: '文字顏色' }));
  fireEvent.click(await screen.findByRole('option', { name: '紅色' }));
  expect(JSON.stringify(editor.document[0]!.content)).toContain('#d44c47');
  fireEvent.click(screen.getByRole('button', { name: '返回格式' }));
  fireEvent.click(screen.getByRole('button', { name: '連結' }));
  fireEvent.change(screen.getByLabelText('連結網址'), { target: { value: 'https://example.test/selection' } });
  await act(async () => { editor.setTextCursorPosition('other', 'start'); });
  fireEvent.click(screen.getByRole('button', { name: '套用連結' }));
  expect(JSON.stringify(editor.document[0]!.content)).toContain('https://example.test/selection');
  expect(JSON.stringify(editor.document[1]!.content)).toContain('https://example.test/selection');
  expect(JSON.stringify(editor.document[2]!.content)).not.toContain('https://example.test/selection');
  fireEvent.click(screen.getByRole('button', { name: '清除文字格式' }));
  expect(JSON.stringify(editor.document[0]!.content)).toContain('synthetic-annotation');
  expect(JSON.stringify(editor.document[0]!.content)).not.toContain('"bold":true');
  expect(JSON.stringify(editor.document[0]!.content)).not.toContain('#d44c47');
});

it('maps the saved selection through document insertions while the panel owns focus', async () => {
  mount(); await focusAndSelect(); await openMobile();
  await act(async () => {
    editor.insertBlocks([{ id: 'inserted', type: 'paragraph', content: '不應套用格式' }], 'first', 'before');
    editor.setTextCursorPosition('other', 'start');
  });
  fireEvent.click(screen.getByRole('button', { name: '粗體' }));
  expect(JSON.stringify(editor.getBlock('first')!.content)).toContain('"bold":true');
  expect(JSON.stringify(editor.getBlock('second')!.content)).toContain('"bold":true');
  expect(JSON.stringify(editor.getBlock('inserted')!.content)).not.toContain('"bold":true');
  expect(JSON.stringify(editor.getBlock('other')!.content)).not.toContain('"bold":true');
});

it('rejects applying formatting after the selected text was removed instead of styling its neighbour', async () => {
  mount(); await focusAndSelect(); await openMobile();
  await act(async () => { editor.removeBlocks(['first', 'second']); });
  fireEvent.click(screen.getByRole('button', { name: '粗體' }));
  expect((await screen.findByRole('alert')).textContent).toContain('選取內容已變更');
  expect(JSON.stringify(editor.getBlock('other')!.content)).not.toContain('"bold":true');
});

it('keeps the desktop first-item submenu open and converts selected paragraphs using the real toolbar and menu', async () => {
  mobile = false; mount();
  await act(async () => { editor.focus(); editor.setSelection('first', 'second'); editor.getExtension(FormattingToolbarExtension)?.store.setState(true); });
  const trigger = await screen.findByRole('button', { name: '轉換段落類型' });
  const user = userEvent.setup(); await user.click(trigger);
  const option = await screen.findByRole('menuitem', { name: dictionary.slash_menu.heading_2.title });
  expect(screen.getByLabelText('文字選取工具')).toBeTruthy();
  await user.click(option);
  await waitFor(() => expect(editor.document[0]!.type).toBe('heading'));
  expect(editor.document.map(block => block.type)).toEqual(['heading', 'heading', 'paragraph']);
  expect(editor.document[0]!.props).toMatchObject({ level: 2 });
});
