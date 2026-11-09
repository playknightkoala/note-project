import { useRef, useState } from 'react';
import { Alert, Button, Group } from '@mantine/core';
import { Plus } from 'lucide-react';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function NewRowInput({ onCreate, opened = false, onClose }: { onCreate: (title: string) => Promise<unknown>; opened?: boolean; onClose?: () => void }) {
  const [editing, setEditing] = useState(opened);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const composing = useRef(false);
  useUpdateGuard(() => { if (editing && title.trim()) throw new Error('請先建立或取消新資料列，再更新。'); });
  const submit = async () => {
    if (busy.current || composing.current) return;
    if (!title.trim()) { setEditing(false); onClose?.(); return; }
    busy.current = true; setPending(true); setError(null);
    try { await onCreate(title); setTitle(''); setEditing(false); onClose?.(); }
    catch (error) { setError(error); }
    finally { busy.current = false; setPending(false); }
  };
  if (!editing) return <Button className="database-add-row" variant="subtle" color="gray" leftSection={<Plus size={14} />} onClick={() => setEditing(true)}>新增頁面</Button>;
  return <div className="database-new-row"><input aria-label="新資料列名稱" placeholder="輸入名稱，按 Enter 建立" className="database-cell database-cell-input" autoFocus value={title} disabled={pending} maxLength={500}
    onChange={event => setTitle(event.currentTarget.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onBlur={() => { if (!error) void submit(); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); void submit(); }
      if (event.key === 'Escape' && !pending) { setEditing(false); setTitle(''); onClose?.(); }
    }} />
    {!!error && <Alert color="red" mt="xs">{errorText(error)}<Group mt="xs"><Button size="compact-xs" onClick={() => { void submit(); }}>重試</Button><Button size="compact-xs" variant="default" onClick={() => { setEditing(false); onClose?.(); }}>取消</Button></Group></Alert>}
  </div>;
}
