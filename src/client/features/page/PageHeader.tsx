import { useRef, useState } from 'react';
import { Alert, Button, Group, Popover } from '@mantine/core';
import { EmojiPicker } from 'frimousse';
import type { EmojiDataResolver } from 'frimousse';
import { Image as ImageIcon, Smile, Trash2 } from 'lucide-react';
import { uploadFile } from '../../api/files.ts';
import { PageTitle } from './PageTitle.tsx';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

// Bundle the pinned BlockNote data: the default resolver fetches a public CDN,
// which is unavailable offline and forbidden by our same-origin CSP.
const resolveEmojiData: EmojiDataResolver = async (locale, { signal, emojiVersion } = {}) => {
  const { loadFrimousseData } = await import('@blocknote/core/emoji-data');
  signal?.throwIfAborted();
  const data = await loadFrimousseData(locale);
  signal?.throwIfAborted();
  return emojiVersion === undefined ? data : { ...data, emojis: data.emojis.filter(emoji => emoji.version <= emojiVersion) };
};

interface Props {
  title: string; icon: string | null; coverUrl: string | null; coverPosition: number;
  onTitle: (title: string) => void; onIcon: (icon: string | null) => void;
  onCover: (coverFileId: string | null) => void; onCoverPosition: (position: number) => void;
  onEnter: () => void;
  /** What the reader may change: `none` for a page shared read-only, `title` for one shared for editing (icon and cover stay the owner's). */
  editable?: 'all' | 'title' | 'none';
}

export const GRADIENTS = ['linear-gradient(120deg, #a1c4fd, #c2e9fb)', 'linear-gradient(120deg, #fbc2eb, #a6c1ee)', 'linear-gradient(120deg, #f6d365, #fda085)', 'linear-gradient(120deg, #84fab0, #8fd3f4)'];

/** Notion-style header: optional cover (with vertical reposition), emoji icon, inline title; hover reveals 新增圖示／封面. */
export function PageHeader({ title, icon, coverUrl, coverPosition, onTitle, onIcon, onCover, onCoverPosition, onEnter, editable = 'all' }: Props) {
  const own = editable === 'all';
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repositioning, setRepositioning] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragStart = useRef<{ y: number; position: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  useUpdateGuard(() => { if (uploading || repositioning !== null) throw new Error('請先完成封面上傳或位置設定，再更新。'); });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const pickCover = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try { const uploaded = await uploadFile(file); onCover(uploaded.id); }
    catch (error) { setUploadError(errorText(error)); }
    finally { setUploading(false); }
  };
  const gradientIndex = coverUrl?.startsWith('gradient:') ? Number(coverUrl.slice(9)) : -1;
  const coverStyle = coverUrl && gradientIndex < 0 ? { backgroundImage: `url("${coverUrl}")`, backgroundPositionY: `${repositioning ?? coverPosition}%`, ...(repositioning !== null ? { touchAction: 'none' } : {}) } : undefined;
  return <div className={`page-header${coverUrl ? ' page-header--cover' : ''}${icon ? ' page-header--icon' : ''}`}>
    {coverUrl && <div className="page-cover" style={coverStyle ?? { background: GRADIENTS[gradientIndex] ?? GRADIENTS[0] }}
      onPointerDown={repositioning === null ? undefined : event => { dragStart.current = { y: event.clientY, position: repositioning }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (repositioning === null || !dragStart.current) return; const delta = (event.clientY - dragStart.current.y) / event.currentTarget.clientHeight * -100; setRepositioning(Math.max(0, Math.min(100, Math.round(dragStart.current.position + delta)))); }}
      onPointerUp={() => { dragStart.current = null; }} onPointerCancel={() => { dragStart.current = null; }}>
      {own && <Group gap={4} className="page-cover__actions" onPointerDown={event => event.stopPropagation()}>
        {repositioning === null ? <>
          <Button size="compact-xs" variant="default" onClick={() => fileInput.current?.click()} loading={uploading}>變更封面</Button>
          {gradientIndex < 0 && <Button size="compact-xs" variant="default" onClick={() => setRepositioning(coverPosition)}>調整位置</Button>}
          <Button size="compact-xs" variant="default" onClick={() => onCover(null)}>移除</Button>
        </> : <>
          <Button size="compact-xs" onClick={() => { onCoverPosition(repositioning); setRepositioning(null); }}>儲存位置</Button>
          <Button size="compact-xs" variant="default" onClick={() => setRepositioning(null)}>取消</Button>
        </>}
      </Group>}
      {repositioning !== null && <div className="page-cover__hint">拖曳圖片調整位置</div>}
    </div>}
    <div className="page-header__body">
      {icon && !own && <span className="page-icon page-icon--static" aria-label="頁面圖示">{icon}</span>}
      {icon && own && <Popover opened={pickerOpen} onChange={setPickerOpen} position="bottom-start" shadow="md" withinPortal>
        <Popover.Target><button type="button" className="page-icon" aria-label="變更圖示" onClick={() => setPickerOpen(o => !o)}>{icon}</button></Popover.Target>
        <Popover.Dropdown p={0}><IconPicker onPick={emoji => { onIcon(emoji); setPickerOpen(false); }} onRemove={() => { onIcon(null); setPickerOpen(false); }} /></Popover.Dropdown>
      </Popover>}
      {own && <Group gap={4} className="page-header__tools">
        {!icon && <Popover opened={pickerOpen} onChange={setPickerOpen} position="bottom-start" shadow="md" withinPortal>
          <Popover.Target><Button size="compact-xs" variant="subtle" color="gray" leftSection={<Smile size={14} />} onClick={() => setPickerOpen(o => !o)}>新增圖示</Button></Popover.Target>
          <Popover.Dropdown p={0}><IconPicker onPick={emoji => { onIcon(emoji); setPickerOpen(false); }} /></Popover.Dropdown>
        </Popover>}
        {!coverUrl && <Button size="compact-xs" variant="subtle" color="gray" leftSection={<ImageIcon size={14} />} onClick={() => onCover(`gradient:${Math.floor(Math.random() * GRADIENTS.length)}`)}>新增封面</Button>}
      </Group>}
      {/* Readers have no tool row; under a cover they keep its height, so the title sits where the owner sees it. */}
      {!own && coverUrl && <div className="page-header__tools" aria-hidden="true" />}
      <PageTitle value={title} onChange={onTitle} onEnter={onEnter} readOnly={editable === 'none'} />
      {uploadError && <Alert color="red" role="alert" mt="sm" withCloseButton onClose={() => setUploadError(null)}>{uploadError}</Alert>}
    </div>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={event => { void pickCover(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
  </div>;
}

export function IconPicker({ onPick, onRemove }: { onPick: (emoji: string) => void; onRemove?: () => void }) {
  return <div className="icon-picker">
    <EmojiPicker.Root onEmojiSelect={({ emoji }) => onPick(emoji)} locale="zh-hant" resolveEmojiData={resolveEmojiData} columns={9} className="icon-picker__root">
      <EmojiPicker.Search className="icon-picker__search" placeholder="搜尋表情符號…" autoFocus />
      <EmojiPicker.Viewport className="icon-picker__viewport">
        <EmojiPicker.Loading className="icon-picker__status">載入中…</EmojiPicker.Loading>
        <EmojiPicker.Empty className="icon-picker__status">沒有符合的表情符號</EmojiPicker.Empty>
        <EmojiPicker.List className="icon-picker__list" components={{
          CategoryHeader: ({ category, ...props }) => <div className="icon-picker__category" {...props}>{category.label}</div>,
          Row: ({ children, ...props }) => <div className="icon-picker__row" {...props}>{children}</div>,
          Emoji: ({ emoji, ...props }) => <button type="button" className="icon-picker__emoji" {...props}>{emoji.emoji}</button>,
        }} />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
    {onRemove && <div className="icon-picker__footer"><Button size="compact-xs" variant="subtle" color="gray" leftSection={<Trash2 size={12} />} onClick={onRemove}>移除圖示</Button></div>}
  </div>;
}
