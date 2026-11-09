import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useUpdateGuard } from '../../updates/guards.ts';

/** Notion-style inline title: a borderless auto-growing textarea; Enter/ArrowDown hand focus to the editor. */
export function PageTitle({ value, onChange, onEnter }: { value: string; onChange: (title: string) => void; onEnter: () => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(value);
  useEffect(() => { if (!timer.current && value !== lastSent.current) { setDraft(value); lastSent.current = value; } }, [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = '0px'; el.style.height = `${el.scrollHeight}px`; } }, [draft]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const update = (next: string) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; lastSent.current = next; onChange(next); }, 400);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); if (timer.current) { clearTimeout(timer.current); timer.current = null; lastSent.current = draft; onChange(draft); } onEnter(); }
  };
  const flush = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; lastSent.current = draft; onChange(draft); } };
  useUpdateGuard(flush);
  return <textarea ref={ref} className="page-title" value={draft} placeholder="無標題" rows={1} maxLength={500} spellCheck={false} aria-label="頁面標題"
    onChange={event => update(event.currentTarget.value.replace(/\r?\n/g, ' '))} onKeyDown={onKeyDown} onBlur={flush} />;
}
