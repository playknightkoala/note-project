import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompositionEvent, KeyboardEvent, MouseEvent } from 'react';

/** BlockNote floating UI that must not react to clicks while an IME composition is open. */
export const FLOATING_UI = '.bn-side-menu, .bn-suggestion-menu, .bn-toolbar, .bn-menu-dropdown, .bn-popover, .bn-table-handle, .bn-extend-button';

/**
 * Tracks IME composition on the editor wrapper. ProseMirror may flush the final composition asynchronously, so the
 * unlock waits 50 ms and is keyed by an epoch so an older end never unlocks a newer composition.
 */
export function useImeGuard(onSettled?: () => void) {
  const composing = useRef(false);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCompositionStartCapture = useCallback(() => {
    epoch.current++;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    composing.current = true; setIsComposing(true);
  }, []);
  const onCompositionEndCapture = useCallback((_event: CompositionEvent) => {
    const current = epoch.current;
    timer.current = setTimeout(() => {
      if (current !== epoch.current) return;
      composing.current = false; setIsComposing(false); timer.current = null;
      settled.current?.();
    }, 50);
  }, []);
  const onClickCapture = useCallback((event: MouseEvent) => {
    if (composing.current && (event.target as Element).closest(FLOATING_UI)) { event.preventDefault(); event.stopPropagation(); }
  }, []);
  const onKeyDownCapture = useCallback((event: KeyboardEvent) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation();
  }, []);
  return {
    composing, isComposing,
    notComposing: () => !composing.current,
    wrapperProps: { onCompositionStartCapture, onCompositionEndCapture, onClickCapture, onKeyDownCapture, 'data-composing': isComposing || undefined },
  };
}
