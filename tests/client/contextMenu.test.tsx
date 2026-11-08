// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider, Menu } from '@mantine/core';
import { ContextMenu } from '../../src/client/features/shell/ContextMenu.tsx';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const action = vi.fn(); const navigate = vi.fn();
  render(<MantineProvider env="test"><ContextMenu label="頁面右鍵選單" items={<Menu.Item onClick={action}>加入最愛</Menu.Item>}>
    {handlers => <div data-testid="surface" tabIndex={0} onClick={navigate} {...handlers}>
      <span>空白區域</span><input aria-label="標題" /><textarea aria-label="內文" />
      <a href="/p/example">連結</a><div contentEditable suppressContentEditableWarning data-testid="editable">文字</div>
      <div className="block-editor" data-testid="editor">編輯器</div>
    </div>}
  </ContextMenu></MantineProvider>);
  return { action, navigate, surface: screen.getByTestId('surface') };
}

it('opens at right click without navigating and executes the selected action only once', async () => {
  const { action, navigate, surface } = setup();
  expect(fireEvent.contextMenu(surface, { clientX: 300, clientY: 200 })).toBe(false);
  expect(screen.getByRole('menu', { name: '頁面右鍵選單' })).toBeTruthy();
  expect(action).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: '加入最愛' }));
  expect(action).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

it.each(['ContextMenu', 'F10'])('opens with the %s key and closes with Escape', async key => {
  const { surface } = setup(); surface.focus();
  fireEvent.keyDown(surface, { key, shiftKey: key === 'F10' });
  const menu = screen.getByRole('menu');
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

it('retains native text, editor, link and Shift+right-click menus', () => {
  const { surface } = setup();
  for (const target of [screen.getByLabelText('標題'), screen.getByLabelText('內文'), screen.getByRole('link'), screen.getByTestId('editable'), screen.getByTestId('editor')]) {
    expect(fireEvent.contextMenu(target)).toBe(true);
  }
  expect(fireEvent.contextMenu(surface, { shiftKey: true })).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('retains native touch behavior and closes the desktop menu on scroll', async () => {
  const { surface } = setup();
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  expect(fireEvent.contextMenu(surface)).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  fireEvent.contextMenu(surface); fireEvent.scroll(window);
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

it('opens only the nearest menu when context surfaces are nested', () => {
  render(<MantineProvider env="test"><ContextMenu label="頁面" items={<Menu.Item>頁面動作</Menu.Item>}>
    {outer => <div {...outer}><ContextMenu label="資料列" items={<Menu.Item>資料列動作</Menu.Item>}>
      {inner => <div {...inner} data-testid="row">資料列</div>}
    </ContextMenu></div>}
  </ContextMenu></MantineProvider>);
  fireEvent.contextMenu(screen.getByTestId('row'));
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menu', { name: '資料列' })).toBeTruthy();
});
