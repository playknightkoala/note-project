import { describe, expect, it } from 'vitest';
import { TABLE_GUTTER, tableBleed } from '../../src/client/features/page/useTableBleed.ts';

describe('table bleed', () => {
  it('extends tables to the page area edge minus the gutter on desktop', () => {
    // 1269px page area right edge, 900px column centred with 96px padding → column right at 1269/2+354
    expect(tableBleed(1529, 1080, 1529)).toBe(1529 - 1080 - TABLE_GUTTER);
    expect(tableBleed(1200, 1104, 1200)).toBe(72); // full width page: only the 96px padding is spare
  });
  it('never extends on phones or when there is no spare room', () => {
    expect(tableBleed(390, 374, 390)).toBe(0);
    expect(tableBleed(1000, 990, 1000)).toBe(0);
  });
});
