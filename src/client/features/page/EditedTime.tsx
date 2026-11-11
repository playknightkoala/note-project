import { useEffect, useReducer } from 'react';
import { editedLabel, fullTime } from './relativeTime.ts';

const REFRESH_MS = 30_000;

/** The label of when the page was last edited, kept current while the page stays open. */
export function useEditedLabel(at: number | undefined, now: () => number = Date.now): string | null {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const id = setInterval(refresh, REFRESH_MS);
    // Timers are throttled in a background tab: catch up as soon as it is looked at again.
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return at === undefined ? null : editedLabel(at, now());
}

export function EditedTime({ at }: { at: number }) {
  const label = useEditedLabel(at);
  return <time className="edited-time" dateTime={new Date(at).toISOString()} title={`最後編輯：${fullTime(at)}`}>{label}</time>;
}
