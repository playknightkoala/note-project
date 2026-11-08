import { Alert, Badge, Button, Group, Stack, Table, Text } from '@mantine/core';
import { useAdminUsers, useMe, useUpdateUser } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';

export function AdminUsers() {
  const me = useMe();
  const users = useAdminUsers();
  const update = useUpdateUser();
  return <Stack gap="md">
    {update.error && <Alert color="red" variant="light">{errorText(update.error)}</Alert>}
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead><Table.Tr><Table.Th>名稱</Table.Th><Table.Th>電子郵件</Table.Th><Table.Th>角色</Table.Th><Table.Th>頁面</Table.Th><Table.Th>狀態</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>
        {(users.data ?? []).map(user => {
          const self = user.id === me.data?.id;
          return <Table.Tr key={user.id}>
            <Table.Td>{user.displayName}{user.username && <Text span c="dimmed" size="xs"> @{user.username}</Text>}</Table.Td>
            <Table.Td>{user.email}</Table.Td>
            <Table.Td>{user.role === 'admin' ? <Badge>管理者</Badge> : <Badge color="gray">一般</Badge>}</Table.Td>
            <Table.Td>{user.pageCount}</Table.Td>
            <Table.Td>{user.disabledAt ? <Badge color="red">已停用</Badge> : <Badge color="green">啟用</Badge>}</Table.Td>
            <Table.Td>
              {!self && <Group gap="xs" wrap="nowrap">
                <Button size="compact-xs" variant="light" onClick={() => update.mutate({ id: user.id, role: user.role === 'admin' ? 'user' : 'admin' })}>{user.role === 'admin' ? '降為一般' : '設為管理者'}</Button>
                <Button size="compact-xs" variant="light" color={user.disabledAt ? 'green' : 'red'} onClick={() => update.mutate({ id: user.id, disabled: !user.disabledAt })}>{user.disabledAt ? '啟用' : '停用'}</Button>
              </Group>}
            </Table.Td>
          </Table.Tr>;
        })}
      </Table.Tbody>
    </Table>
  </Stack>;
}
