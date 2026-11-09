import type { PageResponse } from '@shared/api';

export function exportPageDraft(response: PageResponse): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `筆記草稿-${response.page.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
