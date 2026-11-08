import { describe, expect, it } from 'vitest';
import { autosaveReducer } from '../../src/client/features/page/useAutosave.ts';
import type { AutosaveState } from '../../src/client/features/page/useAutosave.ts';

const base: AutosaveState = { status: 'clean', version: 3, savedAt: null, error: null, conflictHead: null, attempts: 0 };

describe('autosave state machine', () => {
  it('moves clean → dirty → saving → clean and keeps the new version', () => {
    const dirty = autosaveReducer(base, { type: 'dirty' });
    expect(dirty.status).toBe('dirty');
    const saving = autosaveReducer(dirty, { type: 'saving' });
    expect(saving.status).toBe('saving');
    const saved = autosaveReducer(saving, { type: 'saved', version: 4, at: 100, stillDirty: false });
    expect(saved).toMatchObject({ status: 'clean', version: 4, savedAt: 100, attempts: 0 });
    expect(autosaveReducer(saving, { type: 'saved', version: 4, at: 100, stillDirty: true }).status).toBe('dirty');
  });

  it('stays in conflict until explicitly reset, even if more edits arrive', () => {
    const conflict = autosaveReducer(base, { type: 'conflict', head: { version: 9, updatedAt: 1, title: 'x' } });
    expect(conflict.status).toBe('conflict');
    expect(autosaveReducer(conflict, { type: 'dirty' }).status).toBe('conflict');
    const reset = autosaveReducer(conflict, { type: 'reset', version: 9 });
    expect(reset).toMatchObject({ status: 'clean', version: 9, conflictHead: null });
  });

  it('counts failed attempts and distinguishes offline from other errors', () => {
    const offline = autosaveReducer(base, { type: 'error', message: '斷線', offline: true });
    expect(offline).toMatchObject({ status: 'offline', attempts: 1, error: '斷線' });
    const failed = autosaveReducer(offline, { type: 'error', message: '壞了', offline: false });
    expect(failed).toMatchObject({ status: 'error', attempts: 2 });
    expect(autosaveReducer(failed, { type: 'saved', version: 5, at: 1, stillDirty: false }).attempts).toBe(0);
  });
});
