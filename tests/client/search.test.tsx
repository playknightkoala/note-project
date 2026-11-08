// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, useLocation } from 'react-router';
import { CommandPalette } from '../../src/client/features/search/CommandPalette.tsx';
import { Snippet } from '../../src/client/features/search/Snippet.tsx';
import { useSearch } from '../../src/client/api/search.ts';

vi.mock('../../src/client/api/pages.ts', () => ({
  useTree: () => ({ data: [] }),
  useCreatePage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../src/client/api/search.ts', () => ({ SEARCH_PAGE_SIZE: 20, useSearch: vi.fn() }));

function CurrentPath() { return <div data-testid="path">{useLocation().pathname}</div>; }
function setup() {
  const onClose = vi.fn();
  render(<MemoryRouter><MantineProvider env="test"><CommandPalette userId="test-user" opened onClose={onClose} /><CurrentPath /></MantineProvider></MemoryRouter>);
  return { input: screen.getByRole('combobox'), onClose };
}

describe('search palette', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.mocked(useSearch).mockImplementation((_id, query) => ({ data: { results: query ? [{ id: 'p', title: query, icon: null, kind: 'page', updatedAt: 0, breadcrumbs: [], snippet: '安全內容' }] : [], total: query ? 1 : 0, limit: 20, offset: 0 }, isFetching: false, error: null }) as unknown as ReturnType<typeof useSearch>);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('navigates actions with arrow keys and Enter', () => {
    const { input, onClose } = setup();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('path').textContent).toBe('/settings');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('debounces searches and hides old results immediately when the input changes', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '北投' } });
    expect(screen.queryByRole('option', { name: /北投/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole('option', { name: /北投/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: '台南' } });
    expect(screen.queryByRole('option', { name: /北投/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('path').textContent).toBe('/p/p');
  });

  it('does not submit or search during IME composition', async () => {
    const { input, onClose } = setup();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中文' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.mocked(useSearch).mock.lastCall).toEqual(['test-user', '', 0, false]);
    fireEvent.compositionEnd(input);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole('option', { name: /中文/ })).toBeTruthy();
  });
});

it('escapes HTML in snippets and highlights literal queries including regex symbols', () => {
  const html = renderToStaticMarkup(<Snippet text={'<script>alert(1)</script> a+b A+B'} query="a+b" />);
  expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; <mark>a+b</mark> <mark>A+B</mark>');
  expect(renderToStaticMarkup(<Snippet text="<mark>危險</mark>" query="<mark>" />)).toBe('<mark>&lt;mark&gt;</mark>危險&lt;/mark&gt;');
});
