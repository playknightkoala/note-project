import { createContext, useContext } from 'react';

/**
 * What the reader may do in the database on screen. The owner may do everything; a member with edit access changes
 * cells and adds rows; a read-only member and the visitor of a public link only look. `rowHref` is where a row opens.
 */
export interface DatabaseAccess { canEditRows: boolean; canManage: boolean; rowHref: (id: string) => string }
export const ownDatabase: DatabaseAccess = { canEditRows: true, canManage: true, rowHref: id => `/p/${id}` };
export const DatabaseAccessContext = createContext<DatabaseAccess>(ownDatabase);
export const useDatabaseAccess = (): DatabaseAccess => useContext(DatabaseAccessContext);
