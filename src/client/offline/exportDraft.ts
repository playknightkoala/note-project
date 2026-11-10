import type { PageResponse } from '@shared/api';

/** Saves something that exists only on this device as a JSON file, for safekeeping before it is discarded. */
export function exportJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const exportPageDraft = (response: PageResponse): void => exportJson(`筆記草稿-${response.page.id}.json`, response);
