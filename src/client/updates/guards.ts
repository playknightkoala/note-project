import { useEffect, useRef } from 'react';

type UpdateGuard = () => void | Promise<void>;
const guards = new Set<UpdateGuard>();

export function useUpdateGuard(guard: UpdateGuard): void {
  const latest = useRef(guard); latest.current = guard;
  useEffect(() => {
    const check = () => latest.current();
    guards.add(check);
    return () => { guards.delete(check); };
  }, []);
}

export async function prepareForUpdate(): Promise<void> {
  if (document.querySelector('[data-composing="true"]')) throw new Error('請先完成目前的文字輸入，再更新。');
  for (const guard of [...guards]) await guard();
}
