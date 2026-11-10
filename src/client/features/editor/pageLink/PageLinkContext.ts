import { createContext } from 'react';
import type { PageKind } from '@shared/api';

/**
 * Where a link to another page gets its target from. Without a provider it is the user's own page tree. On a page
 * somebody else shares, and on a public link, it is the set of pages that share reaches: anything else is shown as
 * not accessible, and the user's own tree is never asked.
 */
export interface LinkedPage { id: string; title: string; icon: string | null; kind: PageKind; updatedAt?: number }
export interface PageLinks { pages: LinkedPage[]; href: (id: string) => string }
export const PageLinkContext = createContext<PageLinks | null>(null);
