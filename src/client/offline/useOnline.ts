import { useSyncExternalStore } from 'react';
import { CONNECTION_EVENT, connectionState } from './connection.ts';

const subscribe = (notify: () => void) => {
  const events = [CONNECTION_EVENT, 'online', 'offline'];
  for (const event of events) window.addEventListener(event, notify);
  return () => { for (const event of events) window.removeEventListener(event, notify); };
};
export const useConnectionState = () => useSyncExternalStore(subscribe, connectionState);
export const useOnline = () => useConnectionState() === 'online';
