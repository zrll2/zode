import type { RelayClientLike } from "./demo/DemoClient";
import { buildSessionDeleteParams } from "./relay/params";

// Local archive helpers + the real remote delete (order 17b).

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

// Delete the conversation on the Mac. Only an explicit "accepted" counts as
// success; everything else becomes a readable error. Rpc errors propagate.
export async function deleteSession(
  client: RelayClientLike,
  sessionId: string,
): Promise<void> {
  const result = (await client.rpc(
    "session/delete",
    buildSessionDeleteParams(sessionId),
  )) as { status?: unknown; reasonCode?: unknown } | null;
  if (!result || result.status !== "accepted") {
    throw new Error(deleteFailureMessage(result));
  }
}

function deleteFailureMessage(result: { status?: unknown; reasonCode?: unknown } | null): string {
  const reason = typeof result?.reasonCode === "string" ? result.reasonCode : "";
  if (reason === "proto.sessionNotFound") return "That conversation no longer exists.";
  return reason ? `The delete was not accepted (${reason}).` : "The delete was not accepted.";
}
