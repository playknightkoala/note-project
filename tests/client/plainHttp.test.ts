// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '../../src/shared/api.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('a plain-HTTP origin (http://192.168…), where browsers have no crypto.randomUUID', () => {
  it('still loads the offline modules and creates a note', async () => {
    const real = globalThis.crypto;
    // What an insecure context offers: random values, but no randomUUID and no subtle.
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T) => real.getRandomValues(array) });
    vi.stubGlobal('BroadcastChannel', undefined);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    vi.resetModules();
    // Importing used to throw here, before anything was shown: the module made an id while it was loading.
    const notes = await import('../../src/client/offline/notes.ts');
    await import('../../src/client/offline/uploads.ts');
    await import('../../src/client/offline/outbox.ts');
    const me: UserDto = { id: '6f0d6f0c-8a43-4d5b-9c7e-2f1f4f6f0a11', displayName: 'synthetic', email: 'synthetic@example.test', username: null, role: 'user', createdAt: 0 };
    await notes.rememberUser(me);
    const created = await notes.createLocalNote({ title: '區網筆記' });
    expect(created.page.id).toMatch(UUID);
    const saved = await notes.saveLocalContent(created.page.id, [{ id: 'block' }], created.localRevision);
    expect(saved.localRevision).toMatch(UUID);
    expect(saved.localRevision).not.toBe(created.localRevision);
  });
});
