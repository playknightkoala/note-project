import { useEffect, useMemo, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { Anchor, Breadcrumbs, Button, Center, Group, Loader, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Database, FileText, Kanban, List, Table2 } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { evaluateRows } from '@shared/database';
import type { ViewConfig } from '@shared/database';
import { publicLinkPath } from '@shared/shares';
import type { PublicNode, PublicPageDto, PublicShareDto } from '@shared/shares';
import { api, errorText, isApiError } from '../../api/client.ts';
import { dictionary } from '../editor/dictionary.ts';
import { schema } from '../editor/schema.ts';
import { PageLinkContext } from '../editor/pageLink/PageLinkContext.ts';
import type { PageLinks } from '../editor/pageLink/PageLinkContext.ts';
import { DatabaseAccessContext } from '../database/access.ts';
import type { DatabaseAccess } from '../database/access.ts';
import { DataGrid } from '../database/DataGrid.tsx';
import { BoardView, ListView } from '../database/CollectionViews.tsx';
import { CellDisplay } from '../database/CellValueInput.tsx';
import { PageHeader } from '../page/PageHeader.tsx';
import { AttachmentList } from './AttachmentList.tsx';
import { ErrorBoundary } from '../../app/ErrorBoundary.tsx';

type Blocks = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[];
const nothing = () => {};
const resolved = () => Promise.resolve();

/**
 * What the holder of a public link sees: the shared page, read-only, and the pages its scope reaches. It talks to
 * `/api/public/…` only. Nothing here asks who the visitor is: a request that needs an account would sign a
 * remembered account out of this device's offline data.
 */
export function PublicView() {
  const { token = '', pageId } = useParams();
  const share = useQuery({ queryKey: ['public', token], queryFn: () => api<PublicShareDto>('GET', `/api/public/${token}`), retry: false, staleTime: 60_000 });
  const id = pageId ?? share.data?.rootId;
  const page = useQuery({ queryKey: ['public', token, id], queryFn: () => api<PublicPageDto>('GET', `/api/public/${token}/pages/${id}`), enabled: !!id, retry: false });
  const title = page.data?.page.title;
  useEffect(() => { if (title !== undefined) document.title = title || '無標題'; }, [title]);
  const links = useMemo<PageLinks>(() => ({ pages: share.data?.tree ?? [], href: target => publicLinkPath(token, target) }), [share.data, token]);
  const databaseAccess = useMemo<DatabaseAccess>(() => ({ canEditRows: false, canManage: false, rowHref: target => publicLinkPath(token, target) }), [token]);
  const error = share.error ?? page.error;
  if (error) return <Center h="70vh" p="md"><Stack align="center" gap="xs">
    <Text fw={600}>{isApiError(error, 404) ? '這個連結無法開啟' : '無法載入頁面'}</Text>
    <Text c="dimmed" size="sm" ta="center">{isApiError(error, 404) ? '分享可能已經停止，或這個頁面已不存在。請向分享的人確認。' : errorText(error)}</Text>
  </Stack></Center>;
  if (!share.data || !page.data) return <Center h="70vh"><Loader size="sm" /></Center>;
  const { page: shown, breadcrumbs } = page.data;
  return <div className="page public-page">
    <header className="topbar public-bar">
      <Breadcrumbs separator="/" className="topbar__crumbs">{breadcrumbs.map((crumb, index) => <Anchor key={crumb.id} component={Link} to={publicLinkPath(token, crumb.id)} size="sm" c={index === breadcrumbs.length - 1 ? undefined : 'dimmed'} className="crumb">
        {crumb.icon && <span className="crumb__icon">{crumb.icon}</span>}{crumb.title || '無標題'}
      </Anchor>)}</Breadcrumbs>
      <span style={{ flex: 1 }} />
      <Text size="xs" c="dimmed">唯讀分享</Text>
    </header>
    <div className="public-layout">
      {share.data.tree.length > 1 && <PublicNav tree={share.data.tree} token={token} currentId={shown.id} />}
      <main className={`page-body${shown.kind === 'database' ? ' page-body--database' : ''}${shown.fullWidth ? ' page-body--full' : ''}`}>
        <PageHeader title={shown.title} icon={shown.icon} coverUrl={shown.coverUrl} coverPosition={shown.coverPosition} editable="none"
          onTitle={nothing} onIcon={nothing} onCover={nothing} onCoverPosition={nothing} onEnter={nothing} />
        <PageLinkContext.Provider value={links}><DatabaseAccessContext.Provider value={databaseAccess}>
          {page.data.database ? <PublicDatabase key={shown.id} data={page.data.database} /> : <>
            {page.data.row && <Stack gap="xs" className="row-properties">{page.data.row.properties.map(property => <div className="row-property" key={property.id}>
              <Text size="sm" c="dimmed" className="row-property__name">{property.name}</Text>
              <div className="database-cell database-cell--static"><CellDisplay property={property} value={page.data.row!.values[property.id] ?? null} /></div>
            </div>)}</Stack>}
            <ErrorBoundary key={`${shown.id}:${shown.updatedAt}`} fallback={<Text c="dimmed" role="alert">這個頁面的內容無法顯示。</Text>}>
              <PublicBlocks content={shown.content} fullWidth={shown.fullWidth} />
            </ErrorBoundary>
            <AttachmentList content={shown.content} />
          </>}
        </DatabaseAccessContext.Provider></PageLinkContext.Provider>
      </main>
    </div>
  </div>;
}

/** The pages the link reaches, as an indented list. */
function PublicNav({ tree, token, currentId }: { tree: PublicNode[]; token: string; currentId: string }) {
  const rows = useMemo(() => {
    const children = new Map<string | null, PublicNode[]>();
    for (const node of tree) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    const flat: { node: PublicNode; depth: number }[] = [];
    const visit = (parentId: string | null, depth: number) => { for (const node of children.get(parentId) ?? []) { flat.push({ node, depth }); if (depth < 64) visit(node.id, depth + 1); } };
    visit(null, 0);
    return flat;
  }, [tree]);
  return <nav className="public-nav" aria-label="分享的頁面">
    {rows.map(({ node, depth }) => <Link key={node.id} to={publicLinkPath(token, node.id)} className={`tree-row${node.id === currentId ? ' tree-row--active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} aria-current={node.id === currentId ? 'page' : undefined}>
      <span className="tree-row__icon">{node.icon ?? (node.kind === 'database' ? <Database size={15} /> : <FileText size={15} />)}</span>
      <span className="tree-row__title">{node.title || '無標題'}</span>
    </Link>)}
  </nav>;
}

/** The page's blocks in an editor that cannot be typed in: no menus, no toolbars, no trailing empty block. */
function PublicBlocks({ content, fullWidth }: { content: unknown[]; fullWidth: boolean }) {
  const scheme = useComputedColorScheme('light');
  const editor = useCreateBlockNote({
    schema, dictionary, trailingBlock: false,
    ...(content.length ? { initialContent: content as Blocks } : {}),
    links: { onClick: event => { const href = (event.target as HTMLAnchorElement | null)?.closest('a')?.getAttribute('href'); if (href) window.open(href, '_blank', 'noopener'); return false; } },
  });
  return <div className={`block-editor${fullWidth ? ' block-editor--full' : ''}`}>
    <BlockNoteView editor={editor} editable={false} theme={scheme} slashMenu={false} emojiPicker={false} formattingToolbar={false} sideMenu={false} linkToolbar={false} filePanel={false} tableHandles={false} />
  </div>;
}

const viewIcons = { table: Table2, list: List, board: Kanban };

/** A shared database: the owner's views, their saved sorting and filters, nothing editable. Sorting from a column menu changes this screen only. */
function PublicDatabase({ data }: { data: NonNullable<PublicPageDto['database']> }) {
  const [viewId, setViewId] = useState(data.meta.views[0]?.id);
  const [override, setOverride] = useState<ViewConfig | null>(null);
  const view = data.meta.views.find(item => item.id === viewId) ?? data.meta.views[0];
  const config = useMemo<ViewConfig>(() => override ?? view?.config ?? { sorts: [], filters: [] }, [override, view]);
  const rows = useMemo(() => evaluateRows(data.rows, data.meta.properties, config), [data, config]);
  const common = { rows, properties: data.meta.properties, config, onSave: resolved, onCreate: resolved, onTrash: nothing, onReload: nothing, adding: false, onCloseAdd: nothing };
  return <div className="database-view">
    <Group gap={4} className="database-toolbar database-view-tabs" role="tablist" aria-label="資料庫視圖">
      {data.meta.views.map(item => { const Icon = viewIcons[item.type]; return <Button key={item.id} role="tab" aria-selected={view?.id === item.id} variant={view?.id === item.id ? 'light' : 'subtle'} color="gray" size="compact-sm" className="database-view-tab" leftSection={<Icon size={15} />}
        onClick={() => { setViewId(item.id); setOverride(null); }}>{item.name}</Button>; })}
    </Group>
    {view?.type === 'list' ? <ListView {...common} /> : view?.type === 'board' ? <BoardView {...common} moving={false} onMove={nothing} />
      : <DataGrid databaseId={data.meta.id} properties={data.meta.properties} rows={rows} total={rows.length} config={config} onSave={resolved} onReload={nothing} onEditProperty={nothing} onConfig={setOverride}
        onTrash={nothing} onCreate={resolved} onAddProperty={nothing} adding={false} onCloseAdd={nothing} hasMore={false} loadingMore={false} onMore={nothing} />}
    <Text size="xs" c="dimmed" mt="xs">{rows.length} 列</Text>
  </div>;
}
