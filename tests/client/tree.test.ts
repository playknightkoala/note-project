import { describe, expect, it } from 'vitest';
import type { PageNode } from '../../src/shared/api.ts';
import { applyFavorite, applyMove, applyTrash, buildTreeIndex } from '../../src/client/features/shell/treeIndex.ts';
import { flattenTree, projectDrop } from '../../src/client/features/shell/treeDrag.ts';

const node = (id: string, parentId: string | null, position: number, extra: Partial<PageNode> = {}): PageNode =>
  ({ id, parentId, kind: 'page', title: id, icon: null, position, isFavorite: false, favoritePosition: null, hasChildren: false, updatedAt: 0, ...extra });

// a (a1, a2 (a2x)), b, db (database)
const nodes = [node('a', null, 1024, { hasChildren: true }), node('a1', 'a', 1024), node('a2', 'a', 2048, { hasChildren: true }), node('a2x', 'a2', 1024),
  node('b', null, 2048), node('db', null, 3072, { kind: 'database' })];

describe('tree index and optimistic updates', () => {
  it('orders children, finds ancestors and lists favorites', () => {
    const index = buildTreeIndex(nodes);
    expect(index.rootIds).toEqual(['a', 'b', 'db']);
    expect(index.childrenOf('a').map(n => n.id)).toEqual(['a1', 'a2']);
    expect(index.ancestorsOf('a2x').map(n => n.id)).toEqual(['a', 'a2']);
    expect(buildTreeIndex(applyFavorite(nodes, 'b', true)).favorites.map(n => n.id)).toEqual(['b']);
  });

  it('moves a node between parents keeping order and hasChildren consistent', () => {
    const moved = buildTreeIndex(applyMove(nodes, 'a1', null, 1));
    expect(moved.rootIds).toEqual(['a', 'a1', 'b', 'db']);
    expect(moved.byId.get('a')?.hasChildren).toBe(true);
    const emptied = buildTreeIndex(applyMove(applyMove(nodes, 'a1', 'b', 0), 'a2', 'b', 0));
    expect(emptied.byId.get('a')?.hasChildren).toBe(false);
    expect(emptied.childrenOf('b').map(n => n.id)).toEqual(['a2', 'a1']);
    expect(emptied.byId.get('b')?.hasChildren).toBe(true);
  });

  it('trashes a subtree', () => {
    const left = buildTreeIndex(applyTrash(nodes, 'a2'));
    expect([...left.byId.keys()]).toEqual(['a', 'a1', 'b', 'db']);
    expect(buildTreeIndex(applyTrash(nodes, 'a')).rootIds).toEqual(['b', 'db']);
  });
});

describe('drag projection', () => {
  const index = buildTreeIndex(nodes);
  const rows = flattenTree(index, new Set(['a', 'a2']));

  it('flattens only expanded branches', () => {
    expect(rows.map(r => `${r.id}:${r.depth}`)).toEqual(['a:0', 'a1:1', 'a2:1', 'a2x:2', 'b:0', 'db:0']);
    expect(flattenTree(index, new Set()).map(r => r.id)).toEqual(['a', 'b', 'db']);
  });

  it('reorders within a parent and nests under the previous row with a horizontal offset', () => {
    expect(projectDrop(rows, 'b', 'a', 0, 24)).toEqual({ parentId: null, index: 0, depth: 0 });
    // Dragging upward over a2x lands between a2 and a2x, which can only be a2's first child.
    expect(projectDrop(rows, 'b', 'a2x', 0, 24)).toEqual({ parentId: 'a2', index: 0, depth: 2 });
    // Depth is relative to the dragged row: a1 (depth 1) dropped after b keeps depth 1 and nests under b;
    // dragging one indent to the left puts it at the root after b.
    expect(projectDrop(rows, 'a1', 'b', 0, 24)).toEqual({ parentId: 'b', index: 0, depth: 1 });
    expect(projectDrop(rows, 'a1', 'b', -24, 24)).toEqual({ parentId: null, index: 2, depth: 0 });
    expect(projectDrop(rows, 'a1', 'a2x', 24, 24)).toEqual({ parentId: 'a2', index: 1, depth: 2 });
  });

  it('refuses dropping into its own subtree or under a database', () => {
    expect(projectDrop(rows, 'a', 'a2x', 48, 24)).toBeNull();
    expect(projectDrop(rows, 'b', 'db', 24, 24)).toBeNull();
  });
});
