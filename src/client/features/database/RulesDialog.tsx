import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { Plus, Trash2 } from 'lucide-react';
import { filterLabels, operatorsFor, validateView } from '@shared/database';
import type { CellValue, DatabaseProperty, ViewConfig, FilterOperator } from '@shared/database';
import { CellValueInput } from './CellValueInput.tsx';

export function RulesDialog({ mode, properties, config, onApply, onClose }: {
  mode: 'sort' | 'filter'; properties: DatabaseProperty[]; config: ViewConfig; onApply: (config: ViewConfig) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const [error, setError] = useState<string | null>(null);
  const fields = [{ value: 'title', label: '名稱' }, ...properties.map(p => ({ value: p.id, label: p.name }))];
  const changeFilter = (index: number, patch: Partial<ViewConfig['filters'][number]>) => setDraft(current => ({ ...current, filters: current.filters.map((rule, i) => i === index ? { ...rule, ...patch } : rule) }));
  return <Modal opened onClose={onClose} title={mode === 'sort' ? '排序設定' : '篩選設定'} size="lg" closeButtonProps={{ 'aria-label': '關閉條件設定' }}>
    <Stack gap="md">
      <Text size="sm" c="dimmed">{mode === 'sort' ? '由上而下依序排序，空值排在最後。' : '只顯示符合所有條件的資料列。'}</Text>
      {mode === 'sort' ? draft.sorts.map((rule, index) => <Group key={index} gap="xs" wrap="nowrap">
        <Select label={`排序 ${index + 1} 欄位`} data={fields} value={rule.propertyId} allowDeselect={false} onChange={propertyId => { if (propertyId) setDraft(current => ({ ...current, sorts: current.sorts.map((r, i) => i === index ? { ...r, propertyId } : r) })); }} style={{ flex: 1 }} />
        <Select label={`排序 ${index + 1} 方向`} data={[{ value: 'asc', label: '遞增' }, { value: 'desc', label: '遞減' }]} value={rule.direction} allowDeselect={false} onChange={direction => { if (direction) setDraft(current => ({ ...current, sorts: current.sorts.map((r, i) => i === index ? { ...r, direction: direction as 'asc' | 'desc' } : r) })); }} w={110} />
        <ActionIcon mt={24} variant="subtle" color="red" aria-label={`移除排序 ${index + 1}`} onClick={() => setDraft(current => ({ ...current, sorts: current.sorts.filter((_, i) => i !== index) }))}><Trash2 size={16} /></ActionIcon>
      </Group>) : draft.filters.map((rule, index) => {
        const property = properties.find(p => p.id === rule.propertyId) ?? null;
        const filterProperty = property?.type === 'multi_select' ? { ...property, type: 'select' as const } : property;
        return <Stack key={index} gap="xs" className="database-rule"><Group gap="xs" wrap="nowrap">
          <Select label={`條件 ${index + 1} 欄位`} data={fields} value={rule.propertyId} allowDeselect={false} onChange={propertyId => { if (propertyId) {
            const p = properties.find(p => p.id === propertyId);
            changeFilter(index, { propertyId, operator: operatorsFor(p?.type ?? 'title')[0]!, value: p?.type === 'checkbox' ? false : null });
          } }} style={{ flex: 1 }} />
          <Select label={`條件 ${index + 1} 運算子`} data={operatorsFor(property?.type ?? 'title').map(value => ({ value, label: filterLabels[value] }))} value={rule.operator} allowDeselect={false} onChange={operator => { if (operator) changeFilter(index, { operator: operator as FilterOperator }); }} style={{ flex: 1 }} />
          <ActionIcon mt={24} variant="subtle" color="red" aria-label={`移除條件 ${index + 1}`} onClick={() => setDraft(current => ({ ...current, filters: current.filters.filter((_, i) => i !== index) }))}><Trash2 size={16} /></ActionIcon>
        </Group>{!['is_empty', 'is_not_empty'].includes(rule.operator) && <CellValueInput property={filterProperty} label={`條件 ${index + 1} 值`} value={rule.value} onChange={(value: CellValue) => changeFilter(index, { value: Array.isArray(value) ? value[0] ?? null : value })} />}</Stack>;
      })}
      <Button variant="subtle" leftSection={<Plus size={14} />} disabled={mode === 'sort' ? draft.sorts.length >= 10 : draft.filters.length >= 20} onClick={() => setDraft(current => mode === 'sort'
        ? { ...current, sorts: [...current.sorts, { propertyId: 'title', direction: 'asc' }] }
        : { ...current, filters: [...current.filters, { propertyId: 'title', operator: 'contains', value: '' }] })}>{mode === 'sort' ? '新增排序' : '新增條件'}</Button>
      {error && <Alert color="red">{error}</Alert>}
      <Group justify="space-between"><Button variant="subtle" onClick={() => setDraft(current => mode === 'sort' ? { ...current, sorts: [] } : { ...current, filters: [] })}>清除全部{mode === 'sort' ? '排序' : '條件'}</Button><Button onClick={() => {
        const normalized = { ...draft, filters: draft.filters.map(filter => properties.find(p => p.id === filter.propertyId)?.type === 'number' && typeof filter.value === 'string' && filter.value.trim() && Number.isFinite(Number(filter.value)) ? { ...filter, value: Number(filter.value) } : filter) };
        const error = validateView(normalized, properties); setError(error); if (!error) { onApply(normalized); onClose(); }
      }}>套用</Button></Group>
    </Stack>
  </Modal>;
}
