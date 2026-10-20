import { DEFAULT_MODEL_SELECTION, type SessionMode } from "../config";

// Builders for the verified RPC parameter shapes (RELAY_PROTOCOL.md →
// "RPC parameter shapes"). The server rejects unknown keys, so rpc calls
// for these methods should go through here.

export function buildSessionSendParams(
  sessionId: string,
  content: string,
  attachments?: { ref: string; fileName: string; mime: string; bytes: number }[],
) {
  const params: {
    sessionId: string;
    content: string;
    modelSelection: typeof DEFAULT_MODEL_SELECTION;
    attachments?: { ref: string; fileName: string; mime: string; bytes: number }[];
  } = { sessionId, content, modelSelection: DEFAULT_MODEL_SELECTION };
  if (attachments && attachments.length > 0) params.attachments = attachments;
  return params;
}

export function buildAttachmentUploadParams(input: {
  sessionId: string;
  fileName: string;
  mime: string;
  dataBase64: string;
}) {
  return { ...input };
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

export function buildSessionUsageParams(sessionId: string) {
  return { sessionId };
}

export function buildUsageStatsParams(range: "all" | "7d" | "30d") {
  return { range };
}
