import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/client/offline/service-worker.js'], languageOptions: { globals: { ...globals.serviceworker } } },
  {
    files: ['src/server/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/client/**/*.{ts,tsx}', 'tests/client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Browsers have no `crypto.randomUUID` on a plain-HTTP origin (a LAN address); `newId()` works everywhere.
    files: ['src/client/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    rules: { 'no-restricted-properties': ['error', { object: 'crypto', property: 'randomUUID', message: 'Use newId() from @shared/ids: crypto.randomUUID does not exist on plain-HTTP origins.' }] },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
