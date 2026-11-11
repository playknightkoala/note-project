// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { APP_ICON, APP_TITLE, emojiFavicon, tabTitle, useDocumentHead } from '../../src/client/app/documentHead.ts';

function Head({ title, icon }: { title: string | undefined; icon: string | null | undefined }) {
  useDocumentHead(title, icon);
  return null;
}
const icons = () => [...document.querySelectorAll('link[rel="icon"]')].map(link => link.getAttribute('href'));

beforeEach(() => {
  document.head.innerHTML = `<link rel="manifest" href="/manifest.webmanifest" /><link rel="icon" type="image/svg+xml" href="${APP_ICON}" /><title>${APP_TITLE}</title>`;
});
afterEach(cleanup);

it('names the tab after the page', () => {
  expect(tabTitle('TEST')).toBe('TEST | Notes');
  expect(tabTitle('  會議記錄 ')).toBe('會議記錄 | Notes');
  expect(tabTitle('')).toBe('無標題 | Notes');
  expect(tabTitle('   ')).toBe('無標題 | Notes');
});

it('draws the emoji as an SVG icon and keeps markup in an icon as text', () => {
  const svg = decodeURIComponent(emojiFavicon('👋').replace('data:image/svg+xml,', ''));
  expect(svg).toContain('>👋</text>');
  expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')).toBeNull();
  const odd = decodeURIComponent(emojiFavicon('<a&b>').replace('data:image/svg+xml,', ''));
  expect(odd).toContain('>&lt;a&amp;b&gt;</text>');
  expect(new DOMParser().parseFromString(odd, 'image/svg+xml').querySelector('text')?.textContent).toBe('<a&b>');
});

it('shows the title and the emoji of the page, and follows their changes', () => {
  const { rerender } = render(<Head title="Welcome" icon="👋" />);
  expect(document.title).toBe('Welcome | Notes');
  expect(icons()).toEqual([emojiFavicon('👋')]);

  rerender(<Head title="Welcome back" icon="📒" />);
  expect(document.title).toBe('Welcome back | Notes');
  expect(icons()).toEqual([emojiFavicon('📒')]);

  rerender(<Head title="" icon={null} />);
  expect(document.title).toBe('無標題 | Notes');
  expect(icons()).toEqual([APP_ICON]);
  expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
});

it('keeps the logo for a page without an icon', () => {
  const logo = document.querySelector('link[rel="icon"]');
  render(<Head title="TEST" icon={null} />);
  expect(document.title).toBe('TEST | Notes');
  expect(icons()).toEqual([APP_ICON]);
  expect(document.querySelector('link[rel="icon"]')).toBe(logo);
});

it('leaves the tab alone while the page is loading', () => {
  const { rerender } = render(<Head title={undefined} icon={undefined} />);
  expect(document.title).toBe(APP_TITLE);
  expect(icons()).toEqual([APP_ICON]);
  rerender(<Head title="載入完成" icon="✅" />);
  expect(document.title).toBe('載入完成 | Notes');
  expect(icons()).toEqual([emojiFavicon('✅')]);
});

it('restores the app title and logo when the page is left', () => {
  const { unmount } = render(<Head title="Welcome" icon="👋" />);
  unmount();
  expect(document.title).toBe(APP_TITLE);
  expect(icons()).toEqual([APP_ICON]);
});
