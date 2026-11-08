import type { PageNode } from '@shared/api';

export interface TreeIndex {
  byId: Map<string, PageNode>;
  childrenOf: (parentId: string | null) => PageNode[];
  rootIds: string[];
  favorites: PageNode[];
  ancestorsOf: (id: string) => PageNode[];
}

const byPosition = (a: PageNode, b: PageNode) => a.position - b.position || a.updatedAt - b.updatedAt;

export function buildTreeIndex(nodes: PageNode[]): TreeIndex {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string | null, PageNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node); children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort(byPosition);
  const childrenOf = (parentId: string | null) => children.get(parentId) ?? [];
  const ancestorsOf = (id: string) => {
    const chain: PageNode[] = []; const seen = new Set<string>();
    let current = byId.get(id);
    while (current && current.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (current) chain.unshift(current);
    }
    return chain;
  };
  const favorites = nodes.filter(node => node.isFavorite).sort((a, b) => (a.favoritePosition ?? 0) - (b.favoritePosition ?? 0));
  return { byId, childrenOf, rootIds: childrenOf(null).map(node => node.id), favorites, ancestorsOf };
}

/** Pure optimistic updates mirrored on the server; positions are rewritten so order is deterministic. */
export function applyMove(nodes: PageNode[], id: string, parentId: string | null, index: number): PageNode[] {
  const moving = nodes.find(node => node.id === id);
  if (!moving) return nodes;
  const siblings = nodes.filter(node => node.parentId === parentId && node.id !== id).sort(byPosition);
  const slot = Math.min(Math.max(index, 0), siblings.length);
  siblings.splice(slot, 0, { ...moving, parentId });
  const positions = new Map(siblings.map((node, i) => [node.id, (i + 1) * 1024]));
  const oldParentHasChildren = nodes.some(node => node.parentId === moving.parentId && node.id !== id);
  return nodes.map(node => {
    if (node.id === id) return { ...node, parentId, position: positions.get(id)! };
    if (positions.has(node.id)) return { ...node, position: positions.get(node.id)! };
    if (node.id === moving.parentId) return { ...node, hasChildren: oldParentHasChildren };
    if (node.id === parentId) return { ...node, hasChildren: true };
    return node;
  });
}

export function applyFavorite(nodes: PageNode[], id: string, favorite: boolean): PageNode[] {
  const max = Math.max(0, ...nodes.map(node => node.favoritePosition ?? 0));
  return nodes.map(node => node.id === id ? { ...node, isFavorite: favorite, favoritePosition: favorite ? max + 1024 : null } : node);
}

export function applyTrash(nodes: PageNode[], id: string): PageNode[] {
  const removed = new Set<string>([id]);
  let grew = true;
  while (grew) { grew = false; for (const node of nodes) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); grew = true; } }
  const parentId = nodes.find(node => node.id === id)?.parentId ?? null;
  const remaining = nodes.filter(node => !removed.has(node.id));
  return remaining.map(node => node.id === parentId ? { ...node, hasChildren: remaining.some(child => child.parentId === parentId) } : node);
}

export function applyRename(nodes: PageNode[], id: string, title: string | undefined, icon: string | null | undefined): PageNode[] {
  return nodes.map(node => node.id === id ? { ...node, ...(title !== undefined ? { title } : {}), ...(icon !== undefined ? { icon } : {}) } : node);
}
