const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * 「已於 4 小時前 編輯」: how long ago a page was last edited. A time ahead of this device's clock (the server's
 * clock differs slightly) counts as just now; after a week the date is shown instead.
 */
export function editedLabel(at: number, now: number): string {
  const age = now - at;
  if (age < MINUTE) return '剛剛編輯';
  if (age < HOUR) return `已於 ${Math.floor(age / MINUTE)} 分鐘前 編輯`;
  if (age < DAY) return `已於 ${Math.floor(age / HOUR)} 小時前 編輯`;
  if (age < 7 * DAY) return `已於 ${Math.floor(age / DAY)} 天前 編輯`;
  const date = new Date(at);
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `已於 ${date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`} 編輯`;
}

export const fullTime = (at: number) => new Date(at).toLocaleString('zh-TW', { hour12: false });
