import { useEffect } from 'react';

/** What the tab shows outside a page; the same as `index.html` and the icon `vite.config.ts` emits. */
export const APP_TITLE = 'Notes';
export const APP_ICON = '/notes-icon.svg';

export const tabTitle = (title: string) => `${title.trim() || '無標題'} | ${APP_TITLE}`;

const escapeXml = (text: string) => text.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
/** A page's emoji as a tab icon: an SVG in a data URI, the same kind of icon as the logo. */
export const emojiFavicon = (icon: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="53" font-size="96" text-anchor="middle" dominant-baseline="central">${escapeXml(icon)}</text></svg>`)}`;

/** The element is replaced, not changed: not every browser redraws the tab when only `href` changes. */
function setIcon(href: string) {
  const current = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (current?.getAttribute('href') === href) return;
  const link = document.createElement('link');
  link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = href;
  if (current) current.replaceWith(link); else document.head.append(link);
}

/**
 * The browser tab follows the page that is open: 「標題 | Notes」 and the page's emoji, or the logo for a page
 * without an icon. `title` is undefined while the page is loading. Leaving the page restores the app's own tab.
 */
export function useDocumentHead(title: string | undefined, icon: string | null | undefined) {
  useEffect(() => { if (title !== undefined) document.title = tabTitle(title); }, [title]);
  useEffect(() => { setIcon(icon ? emojiFavicon(icon) : APP_ICON); }, [icon]);
  useEffect(() => () => { document.title = APP_TITLE; setIcon(APP_ICON); }, []);
}
