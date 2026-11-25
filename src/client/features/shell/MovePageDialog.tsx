import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack } from '@mantine/core';
import type { PageNode } from '@shared/api';
import { errorText } from '../../api/client.ts';
import { useMovePage } from '../../api/pages.ts';
import { useUiState } from '../../app/uiState.tsx';
import type { TreeIndex } from './treeIndex.ts';

export function MovePageDialog({ page, index, onClose }: { page: PageNode; index: TreeIndex; onClose: () => void }) {
  const [destination, setDestination] = useState<string | null>(null);
  const move = useMovePage();
  const { expandMany } = useUiState();
  const options = [...index.byId.values()].filter(node => node.kind === 'page' && node.id !== page.id
    && !index.ancestorsOf(node.id).some(ancestor => ancestor.id === page.id))
    .map(node => ({ value: node.id, label: [...index.ancestorsOf(node.id), node].map(part => part.title || '無標題').join(' / ') }));
  const submit = () => {
    if (!destination) return;
    const parentId = destination === 'root' ? null : destination;
    move.mutate({ id: page.id, parentId, index: index.childrenOf(parentId).length }, { onSuccess: () => {
      if (parentId) expandMany([...index.ancestorsOf(parentId).map(node => node.id), parentId]);
      onClose();
    } });
  };
  return <Modal opened title={`移動「${page.title || '無標題'}」`} onClose={() => { if (!move.isPending) onClose(); }}>
    <Stack><Select label="移動到" placeholder="搜尋上層頁面" searchable data={[{ value: 'root', label: '最上層' }, ...options]}
      value={destination} onChange={setDestination} nothingFoundMessage="找不到頁面" comboboxProps={{ withinPortal: false }} />
      {move.error && <Alert color="red">{errorText(move.error)}</Alert>}
      <Group justify="flex-end"><Button variant="default" disabled={move.isPending} onClick={onClose}>取消</Button>
        <Button disabled={!destination || (destination === 'root' ? null : destination) === page.parentId} loading={move.isPending} onClick={submit}>移動</Button></Group>
    </Stack>
  </Modal>;
}
