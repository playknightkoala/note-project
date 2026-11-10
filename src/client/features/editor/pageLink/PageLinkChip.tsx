import { useContext } from 'react';
import { useNavigate } from 'react-router';
import { FileText } from 'lucide-react';
import { useTree } from '../../../api/pages.ts';
import { PageLinkContext } from './PageLinkContext.ts';
import type { LinkedPage } from './PageLinkContext.ts';

interface Props { pageId: string; title: string }

export function PageLinkChip(props: Props) {
  const links = useContext(PageLinkContext);
  return links ? <Chip {...props} pages={links.pages} href={links.href} missingText="無法存取這個頁面" /> : <OwnChip {...props} />;
}
function OwnChip(props: Props) {
  const tree = useTree();
  return <Chip {...props} pages={tree.data} href={id => `/p/${id}`} missingText="這個頁面已不存在" />;
}
function Chip({ pageId, title, pages, href, missingText }: Props & { pages: LinkedPage[] | undefined; href: (id: string) => string; missingText: string }) {
  const navigate = useNavigate();
  const live = pages?.find(node => node.id === pageId);
  const missing = pages !== undefined && !live;
  const label = live?.title || title || '無標題';
  return <span className={`page-link-chip${missing ? ' page-link-chip--missing' : ''}`} contentEditable={false} role="link" tabIndex={0}
    title={missing ? missingText : label}
    onClick={event => { event.preventDefault(); if (!missing) navigate(href(pageId)); }}
    onKeyDown={event => { if (event.key === 'Enter' && !missing) navigate(href(pageId)); }}>
    <span className="page-link-chip__icon">{live?.icon ?? <FileText size={14} />}</span>
    <span className="page-link-chip__title">{label}</span>
  </span>;
}
