import { useNavigate } from 'react-router';
import { FileText } from 'lucide-react';
import { useTree } from '../../../api/pages.ts';

export function PageLinkChip({ pageId, title }: { pageId: string; title: string }) {
  const tree = useTree();
  const navigate = useNavigate();
  const live = tree.data?.find(node => node.id === pageId);
  const missing = tree.data !== undefined && !live;
  const label = live?.title || title || '無標題';
  return <span className={`page-link-chip${missing ? ' page-link-chip--missing' : ''}`} contentEditable={false} role="link" tabIndex={0}
    title={missing ? '這個頁面已不存在' : label}
    onClick={event => { event.preventDefault(); if (!missing) navigate(`/p/${pageId}`); }}
    onKeyDown={event => { if (event.key === 'Enter' && !missing) navigate(`/p/${pageId}`); }}>
    <span className="page-link-chip__icon">{live?.icon ?? <FileText size={14} />}</span>
    <span className="page-link-chip__title">{label}</span>
  </span>;
}
