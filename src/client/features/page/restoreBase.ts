import type { PageKind } from '@shared/api';
import { hasDraft, offlineNote, syncNotes } from '../../offline/notes.ts';

/** The part of the autosave a history restore depends on. */
export interface RestoreSaver { settle(): Promise<void>; hasUnsaved(): boolean; version(): number }

/**
 * Everything typed here must be on the server before a history restore replaces the content. Answers the version
 * the restore is made on, or throws with the reason it cannot be made yet.
 */
export async function versionToRestoreOn(autosave: RestoreSaver, kind: PageKind, pageId: string): Promise<number> {
  const unsaved = () => { if (autosave.hasUnsaved()) throw new Error('這裡還有尚未儲存的修改，請先完成儲存再還原歷史版本。'); };
  await autosave.settle();
  // The copy on this device says nothing about text that could not be written to it (no space left, for instance)
  // or that was typed since: what the editor still holds is checked first, and again after the sync.
  unsaved();
  if (hasDraft(kind)) {
    await syncNotes({ force: true });
    const note = await offlineNote(pageId).catch(() => undefined);
    if (note?.pending) throw new Error('這裡還有尚未同步到伺服器的修改。請先完成同步或處理衝突，再還原歷史版本。');
    unsaved();
    if (note) return note.base.page.version;
  }
  return autosave.version();
}
