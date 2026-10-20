import { DEFAULT_MODEL_SELECTION, type SessionMode } from "../config";

// Builders for the verified RPC parameter shapes (RELAY_PROTOCOL.md →
// "RPC parameter shapes"). The server rejects unknown keys, so rpc calls
// for these methods should go through here.

export function buildSessionSendParams(sessionId: string, content: string) {
  return { sessionId, content, modelSelection: DEFAULT_MODEL_SELECTION };
}

export function buildSessionCreateParams(input: {
  workspacePath: string;
  workspaceKey: string;
  mode: SessionMode;
}) {
  return {
    workspace: { workspacePath: input.workspacePath, workspaceKey: input.workspaceKey },
    model: DEFAULT_MODEL_SELECTION,
    mode: input.mode,
  };
}

export function buildSessionSubscribeParams(sessionId: string) {
  return { sessionId, deliveryKind: "web-remote-replayable" };
}

export function buildSessionDeleteParams(sessionId: string) {
  return { sessionId };
}

export function buildSessionUsageParams(sessionId: string) {
  return { sessionId };
}

export function buildUsageStatsParams(range: "all" | "7d" | "30d") {
  return { range };
}
