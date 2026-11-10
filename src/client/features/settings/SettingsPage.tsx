import { Container, Tabs, Title } from '@mantine/core';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/auth.ts';
import { AdminInvites } from './AdminInvites.tsx';
import { AdminUsers } from './AdminUsers.tsx';
import { AppearanceForm } from './AppearanceForm.tsx';
import { PasswordForm } from './PasswordForm.tsx';
import { ProfileForm } from './ProfileForm.tsx';
import { SharedPages } from './SharedPages.tsx';

export function SettingsPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const isAdmin = me.data?.role === 'admin';
  const tab = params.get('tab') ?? 'profile';
  return <Container size="md" py="xl">
    <Title order={2} mb="lg">設定</Title>
    <Tabs value={tab} onChange={value => setParams(value && value !== 'profile' ? { tab: value } : {})} keepMounted={false}>
      <Tabs.List mb="lg">
        <Tabs.Tab value="profile">個人資料</Tabs.Tab>
        <Tabs.Tab value="password">密碼</Tabs.Tab>
        <Tabs.Tab value="appearance">外觀</Tabs.Tab>
        <Tabs.Tab value="shares">分享</Tabs.Tab>
        {isAdmin && <Tabs.Tab value="invites">邀請碼</Tabs.Tab>}
        {isAdmin && <Tabs.Tab value="users">使用者</Tabs.Tab>}
      </Tabs.List>
      <Tabs.Panel value="profile"><ProfileForm /></Tabs.Panel>
      <Tabs.Panel value="password"><PasswordForm /></Tabs.Panel>
      <Tabs.Panel value="appearance"><AppearanceForm /></Tabs.Panel>
      <Tabs.Panel value="shares"><SharedPages /></Tabs.Panel>
      {isAdmin && <Tabs.Panel value="invites"><AdminInvites /></Tabs.Panel>}
      {isAdmin && <Tabs.Panel value="users"><AdminUsers /></Tabs.Panel>}
    </Tabs>
  </Container>;
}
