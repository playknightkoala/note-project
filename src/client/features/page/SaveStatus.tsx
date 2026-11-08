import { Button, Group, Text } from '@mantine/core';
import type { SaveState } from './useAutosave.ts';

const labels: Record<SaveState, string> = { clean: '已儲存', dirty: '編輯中', saving: '儲存中…', conflict: '有衝突', error: '儲存失敗', offline: '離線，稍後重試' };

export function SaveStatus({ status, error, onRetry }: { status: SaveState; error: string | null; onRetry?: () => void }) {
  const tone = status === 'conflict' || status === 'error' ? 'red' : status === 'offline' ? 'orange' : 'dimmed';
  return <Group gap={6} wrap="nowrap" className="save-status" data-status={status} title={error ?? undefined}>
    <span className="save-status__dot" />
    <Text size="xs" c={tone}>{labels[status]}</Text>
    {(status === 'error' || status === 'offline') && onRetry && <Button size="compact-xs" variant="subtle" onClick={onRetry}>重試</Button>}
  </Group>;
}
