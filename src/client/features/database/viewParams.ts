import { viewConfigSchema, validateView } from '@shared/database';
import type { DatabaseProperty, ViewConfig } from '@shared/database';

export function readViewParams(params: URLSearchParams, fallback: ViewConfig, properties: DatabaseProperty[]): { config: ViewConfig; error: string | null } {
  try {
    const config = viewConfigSchema.parse({
      sorts: params.has('sort') ? JSON.parse(params.get('sort')!) : fallback.sorts,
      filters: params.has('filter') ? JSON.parse(params.get('filter')!) : fallback.filters,
      ...(params.has('columns') ? { columns: JSON.parse(params.get('columns')!) } : fallback.columns ? { columns: fallback.columns } : {}),
    });
    return { config, error: validateView(config, properties) };
  } catch { return { config: fallback, error: '網址中的排序或篩選已無效，請重設視圖。' }; }
}
export function writeViewParams(current: URLSearchParams, config: ViewConfig): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('sort', JSON.stringify(config.sorts)); next.set('filter', JSON.stringify(config.filters));
  if (config.columns) next.set('columns', JSON.stringify(config.columns)); else next.delete('columns');
  return next;
}
