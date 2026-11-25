import { z } from 'zod';
import type { ReactNode } from 'react';
import { Button, Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link, useSearchParams } from 'react-router';

const rowIdSchema = z.uuid();
export function useRowPeekId() {
  const [params] = useSearchParams();
  return rowIdSchema.safeParse(params.get('row')).data;
}

export function useRowPeekHref() {
  const [params] = useSearchParams();
  return (id: string) => {
    const next = new URLSearchParams(params);
    next.set('row', id);
    return '?' + next.toString();
  };
}

export function RowPeek({ fullHref, children }: { fullHref: string; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const mobile = useMediaQuery('(max-width: 767px)');
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('row');
    setParams(next, { replace: true });
  };
  return <Drawer opened onClose={close} position="right" size={mobile ? '100%' : 'min(50vw, 760px)'}
    lockScroll={mobile} trapFocus={mobile} withOverlay={mobile} closeOnClickOutside={false}
    classNames={{ body: 'row-peek-body' }} closeButtonProps={{ 'aria-label': '關閉資料列' }}
    title={<Button variant="subtle" size="compact-sm" component={Link} to={fullHref}>開啟完整頁面</Button>}>
    {children}
  </Drawer>;
}
