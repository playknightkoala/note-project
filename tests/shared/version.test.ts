import { expect, it } from 'vitest';
import { isNewerVersion } from '../../src/shared/version.ts';

it('compares numeric versions and never treats equal, older or malformed versions as updates', () => {
  expect(isNewerVersion('1.0.10', '1.0.9')).toBe(true);
  expect(isNewerVersion('1.1.0', '1.0.10')).toBe(true);
  expect(isNewerVersion('2.0.0', '1.20.9')).toBe(true);
  for (const version of ['1.0.9', '1.0.8', '0.9.9', 'invalid', '1.0.10<script>']) expect(isNewerVersion(version, '1.0.9')).toBe(false);
});
