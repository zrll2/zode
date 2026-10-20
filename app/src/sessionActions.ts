// Local archive helpers (order 17b). Deleting conversations from the phone
// is not supported — the agent has no real delete.

export const ARCHIVE_CAP = 150;

// Short key so the SecureStore prefs value stays small: the 8 characters
// after "sess_", or the whole id when it has no such prefix.
export function archiveKey(sessionId: string): string {
  return sessionId.startsWith("sess_") ? sessionId.slice(5, 13) : sessionId;
}

// Newest first; duplicates move to the front; the oldest beyond 150 drop.
export function addArchived(list: string[], sessionId: string): string[] {
  const key = archiveKey(sessionId);
  return [key, ...list.filter((entry) => entry !== key)].slice(0, ARCHIVE_CAP);
}

export function removeArchived(list: string[], sessionId: string): string[] {
  const key = archiveKey(sessionId);
  return list.filter((entry) => entry !== key);
}

export function isArchived(list: string[], sessionId: string): boolean {
  return list.includes(archiveKey(sessionId));
}
