import { Button, Container, Text, Title } from '@mantine/core';
import { isRouteErrorResponse, useRouteError } from 'react-router';

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : '未知錯誤';
  return <Container size="xs" py="xl">
    <Title order={2}>發生錯誤</Title>
    <Text c="dimmed" my="md">{message}</Text>
    <Button onClick={() => window.location.assign('/')}>回到首頁</Button>
  </Container>;
}
