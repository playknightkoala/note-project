// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditedTime } from '../../src/client/features/page/EditedTime.tsx';
import { editedLabel } from '../../src/client/features/page/relativeTime.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const now = new Date(2026, 10, 11, 13, 49, 7).getTime();

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('editedLabel', () => {
  it('counts minutes, hours and days, rounding down', () => {
    expect(editedLabel(now - 59_000, now)).toBe('剛剛編輯');
    expect(editedLabel(now - MINUTE, now)).toBe('已於 1 分鐘前 編輯');
    expect(editedLabel(now - 59 * MINUTE - 59_000, now)).toBe('已於 59 分鐘前 編輯');
    expect(editedLabel(now - HOUR, now)).toBe('已於 1 小時前 編輯');
    expect(editedLabel(now - 4 * HOUR - 30 * MINUTE, now)).toBe('已於 4 小時前 編輯');
    expect(editedLabel(now - DAY, now)).toBe('已於 1 天前 編輯');
    expect(editedLabel(now - 7 * DAY + 1, now)).toBe('已於 6 天前 編輯');
  });

  it('shows the date after a week, with the year when it differs', () => {
    expect(editedLabel(new Date(2026, 10, 3, 9, 0).getTime(), now)).toBe('已於 11月3日 編輯');
    expect(editedLabel(new Date(2025, 11, 31, 23, 0).getTime(), now)).toBe('已於 2025年12月31日 編輯');
  });

  it('treats a time ahead of this device as just now', () => {
    expect(editedLabel(now + 5 * MINUTE, now)).toBe('剛剛編輯');
  });
});

describe('EditedTime', () => {
  it('keeps the label current while the page stays open and follows a newer edit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { rerender } = render(<EditedTime at={now - 4 * HOUR} />);
    const label = screen.getByText('已於 4 小時前 編輯');
    expect(label.getAttribute('datetime')).toBe(new Date(now - 4 * HOUR).toISOString());
    expect(label.getAttribute('title')).toContain('最後編輯：');

    act(() => { vi.advanceTimersByTime(HOUR); });
    expect(screen.getByText('已於 5 小時前 編輯')).toBeTruthy();

    rerender(<EditedTime at={now + HOUR} />);
    expect(screen.getByText('剛剛編輯')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2 * MINUTE); });
    expect(screen.getByText('已於 2 分鐘前 編輯')).toBeTruthy();
  });
});
