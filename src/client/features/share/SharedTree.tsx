import { useMemo } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { ChevronRight, Database, ExternalLink, FileText, LogOut, MoreHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { IncomingShareDto } from '@shared/shares';
import { roleLabels } from '@shared/shares';
import { useLeaveShare } from '../../api/shares.ts';
import { useUiState } from '../../app/uiState.tsx';
import { buildTreeIndex } from '../shell/treeIndex.ts';
import { flattenTree } from '../shell/treeDrag.ts';
import { INDENT } from '../shell/PageTree.tsx';

/** What other accounts share with the user: each shared page with what its scope reaches below it. Nothing here can be moved, added or deleted. */
export function SharedTree({ shares, currentId }: { shares: IncomingShareDto[]; currentId: string | null }) {
  return <div className="page-tree" aria-label="與我共用">{shares.map(share => <SharedBranch key={share.pageId} share={share} currentId={currentId} />)}</div>;
}

function SharedBranch({ share, currentId }: { share: IncomingShareDto; currentId: string | null }) {
  const { expanded, setExpanded } = useUiState();
  const navigate = useNavigate();
  const leave = useLeaveShare();
  const rows = useMemo(() => flattenTree(buildTreeIndex(share.tree), expanded), [share.tree, expanded]);
  return <>{rows.map(({ node, depth }) => {
    const open = expanded.has(node.id), root = node.id === share.pageId;
    return <div key={node.id} className={`tree-row${node.id === currentId ? ' tree-row--active' : ''}`} style={{ paddingLeft: 6 + depth * INDENT }} role="treeitem" aria-expanded={node.hasChildren ? open : undefined} aria-level={depth + 1}
      title={root ? `${share.owner.name} 與你共用 · ${roleLabels[share.role]}` : undefined} onClick={() => navigate(`/p/${node.id}`)}>
      <button type="button" className={`tree-row__chevron${node.hasChildren ? '' : ' tree-row__chevron--empty'}`} aria-label={open ? '收合' : '展開'} tabIndex={-1}
        onClick={event => { event.stopPropagation(); if (node.hasChildren) setExpanded(node.id, !open); }}>
        <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
      </button>
      <span className="tree-row__icon">{node.icon ?? (node.kind === 'database' ? <Database size={15} /> : <FileText size={15} />)}</span>
      <span className="tree-row__title">{node.title || '無標題'}</span>
      {root && <span className="tree-row__owner">{share.owner.name}</span>}
      {root && <span className="tree-row__actions" onClick={event => event.stopPropagation()}>
        <Menu position="bottom-start" shadow="md" width={200} withinPortal>
          <Menu.Target><Tooltip label="共用選項"><ActionIcon variant="subtle" color="gray" size="sm" aria-label={`共用選項：${node.title || '無標題'}`}><MoreHorizontal size={14} /></ActionIcon></Tooltip></Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{share.owner.name} · {roleLabels[share.role]}</Menu.Label>
            <Menu.Item component="a" href={`/p/${node.id}`} target="_blank" rel="noopener noreferrer" leftSection={<ExternalLink size={14} />}>在新分頁開啟</Menu.Item>
            <Menu.Item color="red" leftSection={<LogOut size={14} />} onClick={() => {
              if (window.confirm('從你的清單移除這項共用？之後需要擁有者重新加入才能再開啟。此裝置上尚未同步的修改請先同步或匯出。')) leave.mutate(share.pageId, { onSuccess: () => { if (share.tree.some(item => item.id === currentId)) navigate('/'); } });
            }}>移除這項共用</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </span>}
    </div>;
  })}</>;
}
