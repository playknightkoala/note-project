import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionIcon, Alert, Button, Code, CopyButton, Divider, Group, Loader, Modal, Radio, Select, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { Check, Copy, X } from 'lucide-react';
import type { PageKind } from '@shared/api';
import { databaseScopeLabels, MEMBER_ROLES, publicLinkPath, roleLabels, scopeLabels, SHARE_SCOPES } from '@shared/shares';
import type { MemberRole, ShareScope } from '@shared/shares';
import { errorText } from '../../api/client.ts';
import { useChangeShare, useShareState, useStopSharing } from '../../api/shares.ts';

export interface ShareTarget { id: string; kind: PageKind; title: string }
const ShareDialogContext = createContext<(target: ShareTarget) => void>(() => {});
/** Opens the share dialog for one of the user's own pages. */
export const useShareDialog = () => useContext(ShareDialogContext);

/** One dialog for the whole app, so a menu that closes does not take it along. */
export function ShareDialogHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  return <ShareDialogContext.Provider value={setTarget}>
    {children}
    {target && <ShareDialog key={target.id} page={target} onClose={() => setTarget(null)} />}
  </ShareDialogContext.Provider>;
}

const roles = MEMBER_ROLES.map(role => ({ value: role, label: roleLabels[role] }));

export function ShareDialog({ page, onClose }: { page: ShareTarget; onClose: () => void }) {
  const state = useShareState(page.id);
  const change = useChangeShare(page.id);
  const stop = useStopSharing();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
  const share = state.data?.share ?? null;
  const labels = page.kind === 'database' ? databaseScopeLabels : scopeLabels;
  const link = share?.link ? `${window.location.origin}${publicLinkPath(share.link.token)}` : '';
  const busy = change.isPending || stop.isPending;
  // The choice shows at once; the server's answer replaces it (or, when refused, the previous state comes back).
  const [chosen, setChosen] = useState<{ scope?: ShareScope; link?: boolean }>({});
  const settled = { onSettled: () => setChosen({}) };
  const scope = chosen.scope ?? share?.scope ?? 'page';
  const linkOn = chosen.link ?? !!share?.link;
  const add = () => {
    if (!email.trim() || busy) return;
    change.mutate({ type: 'member', email: email.trim(), role }, { onSuccess: () => setEmail('') });
  };
  return <Modal opened onClose={onClose} title={`分享「${page.title || '無標題'}」`} size="lg" closeButtonProps={{ 'aria-label': '關閉分享' }}>
    {state.isPending && <Loader size="sm" />}
    {state.error && <Alert color="red">{errorText(state.error)}</Alert>}
    {state.data && <Stack gap="md">
      {state.data.inherited.map(item => <Alert key={item.pageId} color="yellow" variant="light" title="這個頁面已經透過上層頁面分享">
        上層的「{item.title || '無標題'}」分享範圍包含這個頁面（{[item.link && '公開連結', item.members > 0 && `${item.members} 位成員`].filter(Boolean).join('、')}）。在這裡停止分享不會影響那一項。
      </Alert>)}
      <Radio.Group label="開放範圍" description="公開連結與下列成員都使用同一個範圍；之後加進範圍內的頁面也會一起開放。" value={scope}
        onChange={value => { const next = value as ShareScope; setChosen({ scope: next }); change.mutate({ type: 'scope', scope: next }, settled); }}>
        <Stack gap={6} mt="xs">{SHARE_SCOPES.map(scope => <Radio key={scope} value={scope} label={labels[scope]} disabled={busy} />)}</Stack>
      </Radio.Group>
      <Divider />
      <Stack gap="xs">
        <Switch label="公開連結" description="知道網址的人不需登入就能閱讀；只能看，看不到留言。" checked={linkOn} disabled={busy}
          onChange={event => { const on = event.currentTarget.checked; setChosen({ link: on }); change.mutate({ type: 'link', on }, settled); }} />
        {share?.link && <>
          <Group gap="xs" wrap="nowrap">
            <Code style={{ flex: 1, overflowWrap: 'anywhere' }} aria-label="公開連結網址">{link}</Code>
            <CopyButton value={link}>{({ copied, copy }) => <Tooltip label={copied ? '已複製' : '複製連結'}><ActionIcon variant="subtle" onClick={copy} aria-label="複製公開連結">{copied ? <Check size={16} /> : <Copy size={16} />}</ActionIcon></Tooltip>}</CopyButton>
          </Group>
          <Text size="xs" c="dimmed">關閉後這個網址永久失效；再次開啟會產生新的網址。把頁面移至垃圾桶也會關閉公開連結。</Text>
        </>}
      </Stack>
      <Divider />
      <Stack gap="xs">
        <Text fw={500} size="sm">與本站帳號共用</Text>
        <Text size="xs" c="dimmed">輸入對方註冊時使用的 email。唯讀與可編輯的成員都能留言與加表情；可編輯的成員還能修改內文、標題與資料列。</Text>
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput label="Email" type="email" placeholder="name@example.com" value={email} onChange={event => setEmail(event.currentTarget.value)} style={{ flex: 1 }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
          <Select label="權限" aria-label="新成員的權限" data={roles} value={role} onChange={value => setRole((value as MemberRole | null) ?? 'viewer')} allowDeselect={false} w={120} comboboxProps={{ withinPortal: false }} />
          <Button onClick={add} loading={change.isPending && change.variables?.type === 'member'} disabled={!email.trim()}>加入</Button>
        </Group>
        {share?.members.map(member => <Group key={member.userId} gap="xs" wrap="nowrap" className="share-member">
          <div style={{ flex: 1, minWidth: 0 }}><Text size="sm" truncate>{member.displayName}</Text><Text size="xs" c="dimmed" truncate>{member.email}</Text></div>
          <Select aria-label={`${member.displayName} 的權限`} data={roles} value={member.role} disabled={busy} allowDeselect={false} w={120} size="xs" comboboxProps={{ withinPortal: false }}
            onChange={value => { if (value && value !== member.role) change.mutate({ type: 'role', userId: member.userId, role: value as MemberRole }); }} />
          <Tooltip label="移除"><ActionIcon variant="subtle" color="red" disabled={busy} aria-label={`移除 ${member.displayName}`} onClick={() => change.mutate({ type: 'remove', userId: member.userId })}><X size={16} /></ActionIcon></Tooltip>
        </Group>)}
        {share && share.members.length === 0 && <Text size="sm" c="dimmed">尚未與任何帳號共用。</Text>}
      </Stack>
      {(change.error || stop.error) && <Alert color="red" role="alert">{errorText(change.error ?? stop.error)}</Alert>}
      <Group justify="space-between">
        {share && (share.link || share.members.length > 0)
          ? <Button variant="subtle" color="red" disabled={busy} onClick={() => { if (window.confirm('停止分享這個頁面？公開連結會失效，所有成員都無法再存取。')) stop.mutate(page.id); }}>停止分享</Button> : <span />}
        <Button variant="default" onClick={onClose}>完成</Button>
      </Group>
    </Stack>}
  </Modal>;
}
