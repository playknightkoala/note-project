import { useEffect } from 'react';
import type { RefObject } from 'react';

export const DESKTOP_MIN_WIDTH = 768;
/** Space kept between a widened table and the right edge of the page area. */
export const TABLE_GUTTER = 24;

/**
 * How far a table block may extend past the right edge of the text column: up to the page area's right edge minus
 * a gutter. Text keeps its reading width; only tables use the spare room. Zero on phones (tables scroll instead).
 */
export function tableBleed(pageRight: number, columnRight: number, viewportWidth: number): number {
  if (viewportWidth < DESKTOP_MIN_WIDTH) return 0;
  return Math.max(0, Math.round(pageRight - columnRight - TABLE_GUTTER));
}

/** Keeps `--table-bleed` on the page body in sync with the layout (window resize, sidebar toggle, full width). */
export function useTableBleed(pageRef: RefObject<HTMLElement | null>, bodyRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const page = pageRef.current, body = bodyRef.current;
    if (!page || !body) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const columnRight = body.getBoundingClientRect().right - (parseFloat(getComputedStyle(body).paddingRight) || 0);
        body.style.setProperty('--table-bleed', `${tableBleed(page.getBoundingClientRect().right, columnRight, window.innerWidth)}px`);
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(page); observer.observe(body);
    window.addEventListener('resize', update);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update); };
  }, [pageRef, bodyRef]);
}
