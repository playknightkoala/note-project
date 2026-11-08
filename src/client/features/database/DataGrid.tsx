import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Menu, Text } from '@mantine/core';
import { ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate } from 'react-router';
import type { CellValue, DatabaseProperty, DatabaseRow, ViewConfig } from '@shared/database';
import { propertyLabels } from '@shared/database';
import { EditableCell } from './EditableCell.tsx';

interface Props {
  databaseId: string; properties: DatabaseProperty[]; rows: DatabaseRow[]; total: number; config: ViewConfig;
  onSave: (row: DatabaseRow, propertyId: string, value: CellValue, version: number) => Promise<unknown>;
  onReload: () => void; onEditProperty: (property: DatabaseProperty) => void; onConfig: (config: ViewConfig) => void;
  onFilter: (property: DatabaseProperty | null) => void;
  onTrash: (row: DatabaseRow) => void; hasMore: boolean; loadingMore: boolean; onMore: () => void;
}
function readWidths(key: string): Record<string, number> {
  try {
    const widths: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!widths || typeof widths !== 'object' || Array.isArray(widths)) return {};
    return Object.fromEntries(Object.entries(widths).filter(([, width]) => typeof width === 'number' && width >= 100 && width <= 600));
  } catch { return {}; }
}
export function DataGrid({ databaseId, properties, rows, total, config, onSave, onReload, onEditProperty, onConfig, onFilter, onTrash, hasMore, loadingMore, onMore }: Props) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const widthKey = `notes:column-widths:${databaseId}`;
  const [widths, setWidths] = useState(() => readWidths(widthKey));
  const resizing = useRef<{ id: string; x: number; width: number } | null>(null);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const visible = properties.filter(property => !config.columns || config.columns.includes(property.id));
  const columns = [{ id: 'title', name: '名稱', property: null }, ...visible.map(property => ({ id: property.id, name: property.name, property }))];
  const template = columns.map(col => `${widths[col.id] ?? (col.id === 'title' ? 260 : 180)}px`).join(' ') + ' 52px';
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 34, overscan: 8 });
  const items = virtual.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;
  useEffect(() => { if (lastIndex >= rows.length - 5 && hasMore && !loadingMore) onMore(); }, [lastIndex, rows.length, hasMore, loadingMore, onMore]);
  const saveWidth = (id: string, width: number) => setWidths(current => {
    const next = { ...current, [id]: Math.max(100, Math.min(600, Math.round(width))) };
    try { localStorage.setItem(widthKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  return <div className="database-grid-scroll" ref={scrollRef} role="grid" aria-label="資料庫表格" aria-rowcount={total + 1} aria-colcount={columns.length + 1}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement;
      if (target.getAttribute('role') !== 'gridcell') return;
      if (event.altKey && event.key === 'Enter') { event.preventDefault(); const row = rows[active.row]; if (row) navigate(`/p/${row.id}`); return; }
      const dr = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      const dc = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!dr && !dc) return;
      event.preventDefault();
      const next = { row: Math.max(0, Math.min(rows.length - 1, active.row + dr)), col: Math.max(0, Math.min(columns.length - 1, active.col + dc)) };
      setActive(next); virtual.scrollToIndex(next.row, { align: 'auto' });
      requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row="${next.row}"][data-col="${next.col}"]`)?.focus());
    }}>
    <div className="database-grid-header" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
      {columns.map(column => <div key={column.id} className="database-column" role="columnheader">
        <Menu position="bottom-start" withinPortal shadow="md"><Menu.Target><Button variant="subtle" color="gray" className="database-column__button" size="compact-sm" aria-label={`欄位選單：${column.name}`}><span>{column.property ? propertyLabels[column.property.type] : 'Aa'}</span> {column.name}</Button></Menu.Target>
          <Menu.Dropdown>{column.property && <Menu.Item onClick={() => onEditProperty(column.property)}>編輯欄位</Menu.Item>}
            <Menu.Item disabled={config.sorts.length >= 10 && !config.sorts.some(sort => sort.propertyId === column.id)} onClick={() => onConfig({ ...config, sorts: [{ propertyId: column.id, direction: 'asc' }, ...config.sorts.filter(sort => sort.propertyId !== column.id)] })}>依此欄遞增</Menu.Item>
            <Menu.Item disabled={config.sorts.length >= 10 && !config.sorts.some(sort => sort.propertyId === column.id)} onClick={() => onConfig({ ...config, sorts: [{ propertyId: column.id, direction: 'desc' }, ...config.sorts.filter(sort => sort.propertyId !== column.id)] })}>依此欄遞減</Menu.Item>
            <Menu.Item disabled={config.filters.length >= 20 && !config.filters.some(filter => filter.propertyId === column.id)} onClick={() => onFilter(column.property)}>依此欄篩選</Menu.Item>
            {column.property && <Menu.Item onClick={() => onConfig({ ...config, columns: visible.filter(p => p.id !== column.id).map(p => p.id) })}>隱藏欄位</Menu.Item>}
          </Menu.Dropdown></Menu>
        <span className="database-column__resize" role="separator" tabIndex={0} aria-label={`調整${column.name}欄寬`} aria-orientation="vertical" aria-valuemin={100} aria-valuemax={600} aria-valuenow={widths[column.id] ?? (column.id === 'title' ? 260 : 180)}
          onPointerDown={event => { event.preventDefault(); resizing.current = { id: column.id, x: event.clientX, width: widths[column.id] ?? (column.id === 'title' ? 260 : 180) }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (resizing.current?.id === column.id) saveWidth(column.id, resizing.current.width + event.clientX - resizing.current.x); }}
          onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); saveWidth(column.id, (widths[column.id] ?? (column.id === 'title' ? 260 : 180)) + (event.key === 'ArrowRight' ? 10 : -10)); } }} />
      </div>)}<div role="columnheader" aria-label="資料列動作" />
    </div>
    <div className="database-grid-body" style={{ height: virtual.getTotalSize() }}>
      {items.map(item => {
        const row = rows[item.index]!;
        return <div key={row.id} role="row" aria-rowindex={item.index + 2} className="database-grid-row" style={{ gridTemplateColumns: template, transform: `translateY(${item.start}px)` }}>
          {columns.map((column, col) => <div className="database-grid-slot" key={column.id}>
            <EditableCell property={column.property} value={column.id === 'title' ? row.title : row.values[column.id] ?? null} version={row.version}
              label={`${row.title || '無標題'}／${column.name}`} rowIndex={item.index} columnIndex={col} tabIndex={active.row === item.index && active.col === col ? 0 : -1}
              onFocus={() => setActive({ row: item.index, col })} onSave={(value, version) => onSave(row, column.id, value, version)} onReload={onReload} />
            {column.id === 'title' && <ActionIcon size="xs" className="database-open-row" variant="subtle" aria-label={`開啟資料列：${row.title || '無標題'}`} onClick={() => navigate(`/p/${row.id}`)}><ExternalLink size={13} /></ActionIcon>}
          </div>)}
          <Menu withinPortal position="bottom-end"><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`資料列選單：${row.title || '無標題'}`}><MoreHorizontal size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown><Menu.Item leftSection={<ExternalLink size={14} />} onClick={() => navigate(`/p/${row.id}`)}>開啟為頁面</Menu.Item><Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => onTrash(row)}>移至垃圾桶</Menu.Item></Menu.Dropdown>
          </Menu>
        </div>;
      })}
    </div>
    {rows.length === 0 && <Text size="sm" c="dimmed" p="xl">沒有符合條件的資料列。</Text>}
    {hasMore && <Button variant="subtle" size="xs" loading={loadingMore} onClick={onMore}>載入更多資料列</Button>}
  </div>;
}
