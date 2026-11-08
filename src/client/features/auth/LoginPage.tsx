import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Anchor, Button, Checkbox, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuthStatus, useLogin, useMe } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';
import { AuthLayout } from './AuthLayout.tsx';

const REMEMBER_KEY = 'notes:remembered-identifier';
function readRemembered(): string | null { try { return localStorage.getItem(REMEMBER_KEY); } catch { return null; } }
function writeRemembered(value: string | null): void {
  try { if (value) localStorage.setItem(REMEMBER_KEY, value); else localStorage.removeItem(REMEMBER_KEY); } catch { /* storage unavailable */ }
}

export function LoginPage() {
  const me = useMe();
  const status = useAuthStatus();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const remembered = readRemembered();
  const [identifier, setIdentifier] = useState(remembered ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(remembered !== null);
  const next = params.get('next') ?? '/';
  if (me.data) return <Navigate to={next.startsWith('/') ? next : '/'} replace />;
  if (status.data?.setupRequired) return <Navigate to="/register" replace />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    writeRemembered(remember ? identifier.trim() : null);
    login.mutate({ identifier, password }, { onSuccess: () => navigate(next.startsWith('/') ? next : '/', { replace: true }) });
  };
  return <AuthLayout title="登入" subtitle="使用電子郵件或使用者名稱登入。">
    <form onSubmit={submit}>
      <Stack gap="md">
        {login.error && <Alert color="red" variant="light">{errorText(login.error)}</Alert>}
        <TextInput label="電子郵件或使用者名稱" autoComplete="username" required value={identifier} onChange={e => setIdentifier(e.currentTarget.value)} autoFocus={remembered === null} />
        <PasswordInput label="密碼" autoComplete="current-password" required value={password} onChange={e => setPassword(e.currentTarget.value)} autoFocus={remembered !== null} />
        <Checkbox label="記住帳號" description="只記住帳號名稱，不會儲存密碼" checked={remember} onChange={e => setRemember(e.currentTarget.checked)} />
        <Button type="submit" loading={login.isPending} fullWidth>登入</Button>
        <Text size="sm" c="dimmed" ta="center">有邀請碼？<Anchor component={Link} to="/register">註冊帳號</Anchor></Text>
      </Stack>
    </form>
  </AuthLayout>;
}
