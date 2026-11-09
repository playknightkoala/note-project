// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { activateAppUpdate } from '../../src/client/updates/activate.ts';

class TestChannel {
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() };
  port2 = { close: vi.fn(), reply: (data: unknown) => this.port1.onmessage?.({ data }) };
}
function setup(waitingVersion = '1.0.8', activeVersion = '1.0.7') {
  vi.stubGlobal('MessageChannel', TestChannel);
  const container = new EventTarget() as EventTarget & { controller: unknown; getRegistration: ReturnType<typeof vi.fn> };
  const worker = (version: string, activate?: () => void) => ({ postMessage: vi.fn((message: { type: string }, ports?: TestChannel['port2'][]) => {
    if (message.type === 'notes:get-version') queueMicrotask(() => ports?.[0]?.reply({ version }));
    if (message.type === 'notes:activate-update') activate?.();
  }) });
  const waiting = worker(waitingVersion, () => { container.controller = waiting; container.dispatchEvent(new Event('controllerchange')); });
  const registration = { waiting: waiting as typeof waiting | null, active: worker(activeVersion), installing: null, update: vi.fn().mockResolvedValue(undefined) };
  container.controller = registration.active;
  container.getRegistration = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  return { container, registration, waiting };
}
afterEach(() => { Reflect.deleteProperty(navigator, 'serviceWorker'); vi.unstubAllGlobals(); });

it('activates the requested downloaded worker before reloading this tab', async () => {
  const { registration, waiting } = setup(); const reload = vi.fn();
  await activateAppUpdate('1.0.8', reload);
  expect(registration.update).toHaveBeenCalledOnce();
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'notes:activate-update', version: '1.0.8' });
  expect(reload).toHaveBeenCalledWith('1.0.8');
});

it('refuses a mismatched downloaded worker rather than activating an unintended version', async () => {
  const { waiting } = setup('1.0.9'); const reload = vi.fn();
  await expect(activateAppUpdate('1.0.8', reload)).rejects.toThrow('版本與伺服器不同');
  expect(waiting.postMessage.mock.calls.some(([message]) => message.type === 'notes:activate-update')).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

it('keeps the current interface when downloading the new worker fails', async () => {
  const { registration } = setup(); const reload = vi.fn();
  registration.update.mockRejectedValue(new Error('network unavailable'));
  await expect(activateAppUpdate('1.0.8', reload)).rejects.toThrow('下載新版介面失敗');
  expect(reload).not.toHaveBeenCalled();
});

it('can reload into the target version already activated by another tab', async () => {
  const { registration } = setup('1.0.8', '1.0.8'); const reload = vi.fn();
  registration.waiting = null;
  await activateAppUpdate('1.0.8', reload);
  expect(reload).toHaveBeenCalledWith('1.0.8');
});

it('does not reload if the only available worker is still the old version', async () => {
  const { registration } = setup(); const reload = vi.fn();
  registration.waiting = null;
  await expect(activateAppUpdate('1.0.8', reload)).rejects.toThrow('尚未下載完成');
  expect(reload).not.toHaveBeenCalled();
});

it('reloads normally in a browser without service worker support', async () => {
  Reflect.deleteProperty(navigator, 'serviceWorker'); const reload = vi.fn();
  await activateAppUpdate('1.0.8', reload);
  expect(reload).toHaveBeenCalledWith('1.0.8');
});
