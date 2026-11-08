import { useEffect, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Menu } from '@mantine/core';

interface Handlers { onContextMenu: (event: MouseEvent<HTMLElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void }
const NATIVE_TARGETS = 'input, textarea, select, a, [contenteditable]:not([contenteditable="false"]), .block-editor, [role="dialog"], [role="menu"], [data-native-context-menu]';

/** Cursor-positioned desktop menu. Text editing, links and touch gestures retain their native behavior. */
export function ContextMenu({ children, items, label }: { children: (handlers: Handlers) => ReactNode; items: ReactNode; label: string }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const eligible = (target: EventTarget) => window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && target instanceof Element && !target.closest(NATIVE_TARGETS);
  const open = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.shiftKey || !eligible(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setPoint(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: bounds.left + 12, y: bounds.top + 12 });
  };
  const keydown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || !eligible(event.target)) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      setPoint({ x: bounds.left + 12, y: bounds.top + 12 });
    }
  };
  useEffect(() => {
    if (!point) return;
    const close = () => setPoint(null);
    const scroll = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest('[data-context-menu-dropdown]')) close(); };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true); };
  }, [point]);
  return <Menu opened={point !== null} onChange={opened => { if (!opened) setPoint(null); }} withinPortal floatingStrategy="fixed" hideDetached={false}
    position="bottom-start" offset={3} width={220} shadow="md" transitionProps={{ duration: 0 }}>
    {children({ onContextMenu: open, onKeyDown: keydown })}
    {point && <Menu.Target><span aria-hidden="true" aria-label={label} style={{ position: 'fixed', left: point.x, top: point.y, width: 1, height: 1, pointerEvents: 'none' }} /></Menu.Target>}
    <Menu.Dropdown aria-label={label} data-context-menu-dropdown onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>{items}</Menu.Dropdown>
  </Menu>;
}
