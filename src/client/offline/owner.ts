/**
 * The account this tab keeps offline data for, and the keys its records live under. Kept apart from the modules that
 * read and write those records so they can all depend on it.
 */
let ownerId: string | null = null;
export const offlineOwner = (): string | null => ownerId;
export const setOfflineOwner = (id: string | null): void => { ownerId = id; };

export const pageKey = (userId: string, id: string): string => `page:${userId}:${id}`;
export const databaseKey = (userId: string, id: string): string => `db:${userId}:${id}`;
export const annotationsKey = (userId: string, pageId: string): string => `annotations:${userId}:${pageId}`;
export const opPrefix = (userId: string): string => `op:${userId}:`;
export const uploadKey = (userId: string, id: string): string => `upload:${userId}:${id}`;
export const uploadCache = (userId: string): string => `notes-uploads-${userId}`;
export const fileCache = (userId: string): string => `notes-files-${userId}`;
