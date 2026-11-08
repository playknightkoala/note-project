import type { Db } from '../db/driver.ts';
import type { SearchResponse } from '../../shared/api.ts';
import { breadcrumbs } from './pages.ts';
import type { PageRow } from './pages.ts';

function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 45);
  const end = Math.min(text.length, start + Math.max(180, query.length + 60));
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Literal substring search: quoted FTS phrases, or escaped LIKE for one/two Unicode characters. */
export function searchPages(db: Db, userId: string, query: string, limit: number, offset: number): SearchResponse {
  if (!query) return { results: [], total: 0, limit, offset };
  const useFts = Array.from(query).length >= 3;
  const from = useFts ? 'page_fts JOIN pages p ON p.rid = page_fts.rowid' : 'pages p';
  const match = useFts ? 'page_fts MATCH ?' : "(p.title LIKE ? ESCAPE '\\' OR p.content_text LIKE ? ESCAPE '\\')";
  const needle = useFts ? `"${query.replace(/"/g, '""')}"` : `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const params = useFts ? [userId, needle] : [userId, needle, needle];
  const where = `p.user_id = ? AND p.trashed_at IS NULL AND ${match}`;
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, ...params)?.n ?? 0);
  const order = useFts ? 'bm25(page_fts, 10.0, 1.0), p.updated_at DESC, p.id' : 'p.updated_at DESC, p.id';
  const rows = db.all<PageRow>(`SELECT p.* FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return {
    results: rows.map(row => ({ id: row.id, title: row.title, icon: row.icon, kind: row.kind, updatedAt: row.updated_at,
      breadcrumbs: breadcrumbs(db, userId, row), snippet: excerpt(row.content_text, query) })),
    total, limit, offset,
  };
}
