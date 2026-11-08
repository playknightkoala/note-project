import { createTheme, localStorageColorSchemeManager } from '@mantine/core';

export const colorSchemeManager = localStorageColorSchemeManager({ key: 'notes-color-scheme' });

export const theme = createTheme({
  fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", Helvetica, Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  headings: { fontWeight: '700' },
  primaryColor: 'blue',
  defaultRadius: 'sm',
  cursorType: 'pointer',
  components: {
    Button: { defaultProps: { size: 'sm' } },
    TextInput: { defaultProps: { size: 'sm' } },
    PasswordInput: { defaultProps: { size: 'sm' } },
  },
});
