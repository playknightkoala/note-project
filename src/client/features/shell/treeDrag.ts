import type { PageNode } from '@shared/api';
import type { TreeIndex } from './treeIndex.ts';

export interface FlatRow { id: string; parentId: string | null; depth: number; index: number; node: PageNode }

/** Rows in display order, respecting which parents are expanded. */
export function flattenTree(index: TreeIndex, expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    index.childrenOf(parentId).forEach((node, i) => {
      rows.push({ id: node.id, parentId, depth, index: i, node });
      if (expanded.has(node.id)) visit(node.id, depth + 1);
    });
  };
  visit(null, 0);
  return rows;
}

export interface DropProjection { parentId: string | null; index: number; depth: number }

/**
 * dnd-kit "sortable tree" projection: the horizontal drag offset chooses the depth between the next row's depth
 * (minimum) and the previous row's depth + 1 (maximum); the parent is the closest earlier row at depth - 1.
 * Returns null when the drop would land inside the dragged subtree or on a database.
 */
export function projectDrop(rows: FlatRow[], activeId: string, overId: string, offsetX: number, indentWidth: number): DropProjection | null {
  const activeIndex = rows.findIndex(row => row.id === activeId);
  const overIndex = rows.findIndex(row => row.id === overId);
  if (activeIndex < 0 || overIndex < 0) return null;
  const active = rows[activeIndex]!;
  // Remove the dragged subtree from consideration.
  const subtree = new Set<string>([activeId]);
  for (let i = activeIndex + 1; i < rows.length && rows[i]!.depth > active.depth; i++) subtree.add(rows[i]!.id);
  if (subtree.has(overId)) return null;
  const list = rows.filter(row => !subtree.has(row.id));
  const insertAt = Math.min(list.findIndex(row => row.id === overId) + (overIndex > activeIndex ? 1 : 0), list.length);
  const previous = list[insertAt - 1];
  const next = list[insertAt];
  const dragDepth = Math.round(offsetX / indentWidth);
  const projected = active.depth + dragDepth;
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(maxDepth, projected));
  let parentId: string | null = null;
  if (depth > 0 && previous) {
    if (previous.depth === depth - 1) parentId = previous.id;
    else if (previous.depth >= depth) {
      for (let i = insertAt - 1; i >= 0; i--) { if (list[i]!.depth === depth - 1) { parentId = list[i]!.id; break; } }
    } else return null;
    if (previous.depth < depth - 1) return null;
  }
  const parent = parentId ? list.find(row => row.id === parentId) : undefined;
  if (parent && parent.node.kind === 'database') return null;
  const siblingsBefore = list.slice(0, insertAt).filter(row => row.parentId === parentId).length;
  return { parentId, index: siblingsBefore, depth };
}
