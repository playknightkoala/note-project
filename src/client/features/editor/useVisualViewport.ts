import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

function viewportRect() {
  const viewport = window.visualViewport;
  return { top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
}

/** Position the explicit mobile controls in the visible area, including when an input opens the keyboard. */
export function useVisualViewport() {
  const [rect, setRect] = useState(viewportRect);
  useEffect(() => {
    const update = () => setRect(viewportRect());
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  const style = {
    '--selection-vv-top': `${rect.top}px`, '--selection-vv-left': `${rect.left}px`,
    '--selection-vv-width': `${rect.width}px`, '--selection-vv-height': `${rect.height}px`,
  } as CSSProperties;
  return { rect, style };
}
