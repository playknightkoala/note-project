/**
 * A note's text that was fixed for sending (`sending`) can end up showing an attachment that will not be on the
 * server when it arrives, while the draft has moved on and no longer shows it. Sending the old text would publish
 * a note with a missing file; changing or dropping what was fixed is not safe either (it may have reached the
 * server, or another tab may send it). The user decides, through the same choice as for any conflict.
 */
export const ASK_ABOUT_FIXED_TEXT = '先前準備送出的內容含有尚未上傳的附件，而這裡的內容已經不同。請選擇以這裡的內容覆蓋，或載入線上版本。';

/** The parts of a stored note this decision needs. */
export interface FixedTextNote {
  base: { page: { version: number; title: string; updatedAt: number } };
  local: { page: { content: unknown } };
  sending?: { input: { content: unknown } };
  problem?: string;
  conflict?: { version: number; title: string; updatedAt: number };
}

export const showsAddress = (content: unknown, urls: readonly string[]): boolean => {
  if (!urls.length) return false;
  const text = JSON.stringify(content);
  return urls.some(url => text.includes(url));
};

/** Whether what was fixed shows one of these addresses and the draft does not. */
export const fixedTextIsStale = (note: FixedTextNote, urls: readonly string[]): boolean =>
  !!note.sending && showsAddress(note.sending.input.content, urls) && !showsAddress(note.local.page.content, urls);

/** The note as it is once the user has to be asked. What was fixed stays as it is. */
export const askAboutFixedText = <T extends FixedTextNote>(note: T): T => ({
  ...note, problem: ASK_ABOUT_FIXED_TEXT,
  conflict: { version: note.base.page.version, title: note.base.page.title, updatedAt: note.base.page.updatedAt },
});
