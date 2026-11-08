import { Radio, Stack, Text, useMantineColorScheme } from '@mantine/core';

export function AppearanceForm() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return <Stack gap="md" maw={420}>
    <Text size="sm" c="dimmed">主題會記在這個瀏覽器。</Text>
    <Radio.Group value={colorScheme} onChange={value => setColorScheme(value as 'light' | 'dark' | 'auto')} label="主題">
      <Stack gap="xs" mt="xs">
        <Radio value="light" label="淺色" />
        <Radio value="dark" label="深色" />
        <Radio value="auto" label="跟隨系統" />
      </Stack>
    </Radio.Group>
  </Stack>;
}
