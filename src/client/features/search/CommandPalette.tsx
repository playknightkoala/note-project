import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { FileText, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useCreatePage, useTree } from '../../api/pages.ts';
import { SEARCH_PAGE_SIZE, useSearch } from '../../api/search.ts';
import { errorText } from '../../api/client.ts';
import { Snippet } from './Snippet.tsx';

interface Props { opened: boolean; onClose: () => void; userId: string }
interface Entry { id: string; title: string; description?: string; snippet?: string; icon: ReactNode; select: () => void }

function readRecent(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 10) : [];
  } catch { return []; }
}

export function CommandPalette({ opened, onClose, userId }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const tree = useTree();
  const create = useCreatePage();
  const recentKey = `notes:recent-pages:${userId}`;
  const [recentIds, setRecentIds] = useState(() => readRecent(recentKey));
  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(0);
  const search = useSearch(userId, query, offset, opened && !composing && input.trim() === query);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = location.pathname.match(/^\/p\/([^/]+)$/)?.[1];
    if (!id || !tree.data?.some(page => page.id === id)) return;
    setRecentIds(current => {
      if (current[0] === id) return current;
      const next = [id, ...current.filter(value => value !== id)].slice(0, 10);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* private browsing/storage quota */ }
      return next;
    });
  }, [location.pathname, recentKey, tree.data]);

  useEffect(() => {
    if (!opened || composing) return;
    const timer = setTimeout(() => { setQuery(input.trim()); setOffset(0); setActive(0); }, 200);
    return () => clearTimeout(timer);
  }, [input, opened, composing]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const go = (path: string) => { onClose(); navigate(path); };
  const waiting = input.trim() !== query || composing;
  const entries: Entry[] = input.trim() ? (waiting ? [] : search.data?.results ?? []).map(result => ({
    id: result.id, title: result.title || '無標題',
    description: result.breadcrumbs.slice(0, -1).map(page => page.title || '無標題').join(' / ') || '根頁面',
    snippet: result.snippet, icon: result.icon || <FileText size={18} />, select: () => go(`/p/${result.id}`),
  })) : [
    ...recentIds.flatMap(id => {
      const page = tree.data?.find(page => page.id === id);
      return page ? [{ id, title: page.title || '無標題', description: '最近開啟', icon: page.icon || <FileText size={18} />, select: () => go(`/p/${id}`) }] : [];
    }),
    { id: 'action:new', title: '新增頁面', icon: <Plus size={18} />, select: () => { if (!create.isPending) create.mutate({}, { onSuccess: result => go(`/p/${result.page.id}`) }); } },
    { id: 'action:settings', title: '設定', icon: <Settings size={18} />, select: () => go('/settings') },
    { id: 'action:trash', title: '垃圾桶', icon: <Trash2 size={18} />, select: () => go('/trash') },
  ];
  const close = () => { composingRef.current = false; setComposing(false); onClose(); };

  return <Modal opened={opened} onClose={close} title="搜尋與指令" size="lg" centered returnFocus closeOnEscape={!composing} closeButtonProps={{ 'aria-label': '關閉搜尋' }}
    onExitTransitionEnd={() => { setInput(''); setQuery(''); setOffset(0); setActive(0); }}>
    <Stack gap="sm">
      <TextInput placeholder="搜尋頁面標題或內容…" aria-label="搜尋頁面" autoFocus data-autofocus leftSection={<Search size={17} />}
        value={input} maxLength={200} onChange={event => { setInput(event.currentTarget.value); setActive(0); }}
        role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="search-results"
        aria-activedescendant={entries[active] ? `search-option-${active}` : undefined}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) { event.stopPropagation(); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setActive(current => entries.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length : 0);
          } else if (event.key === 'Enter') { event.preventDefault(); entries[active]?.select(); }
        }} />
      <Text size="xs" c="dimmed" aria-live="polite">{!input.trim() ? '最近開啟與常用動作' : waiting || search.isFetching ? '搜尋中…' : `找到 ${search.data?.total ?? 0} 個頁面`}</Text>
      {search.error && !waiting && <Alert color="red" title="搜尋失敗"><Text size="sm">{errorText(search.error)}</Text><Button size="compact-xs" mt="xs" onClick={() => { void search.refetch(); }}>重試</Button></Alert>}
      {create.error && <Alert color="red">{errorText(create.error)}</Alert>}
      <div id="search-results" role="listbox" aria-label="頁面與指令" className="search-results" ref={listRef} aria-busy={waiting || search.isFetching}>
        {entries.map((entry, index) => <button key={entry.id} type="button" role="option" id={`search-option-${index}`} aria-selected={index === active}
          className="search-result" tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={entry.select}>
          <span className="search-result__icon" aria-hidden>{entry.icon}</span>
          <span className="search-result__body">
            <span className="search-result__title"><Snippet text={entry.title} query={query} /></span>
            {entry.description && <span className="search-result__path">{entry.description}</span>}
            {entry.snippet && <span className="search-result__snippet"><Snippet text={entry.snippet} query={query} /></span>}
          </span>
        </button>)}
        {input.trim() && !waiting && !search.isFetching && !search.error && entries.length === 0 && <Text ta="center" c="dimmed" py="xl">沒有符合的頁面。</Text>}
      </div>
      {input.trim() && search.isFetching && <Loader size="sm" aria-label="搜尋中" />}
      {!!query && !waiting && !!search.data?.total && <Group justify="space-between">
        <Text size="xs" c="dimmed">第 {offset + 1}–{Math.min(offset + SEARCH_PAGE_SIZE, search.data.total)} 筆</Text>
        <Group gap="xs">
          <Button size="compact-xs" variant="subtle" disabled={offset === 0 || search.isFetching} onClick={() => { setOffset(value => value - SEARCH_PAGE_SIZE); setActive(0); }}>上一頁</Button>
          <Button size="compact-xs" variant="subtle" disabled={offset + SEARCH_PAGE_SIZE >= search.data.total || search.isFetching} onClick={() => { setOffset(value => value + SEARCH_PAGE_SIZE); setActive(0); }}>下一頁</Button>
        </Group>
      </Group>}
      <Text size="xs" c="dimmed">↑ ↓ 選擇 · Enter 開啟 · Esc 關閉 · Ctrl / ⌘ K 搜尋</Text>
    </Stack>
  </Modal>;
}
