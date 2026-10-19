// Frame types from RELAY_PROTOCOL.md. Everything is JSON text frames on one WebSocket.

export interface RelayServer {
  pid: number;
  cwd: string;
}

// phone → relay
export interface AuthFrame {
  type: "auth";
  token: string;
  since?: number;
}

export interface RpcRequestFrame {
  type: "rpc";
  id: string;
  method: string;
  params?: unknown;
  server?: string | number;
}

export interface ServersFrame {
  type: "servers";
}

export interface ResumeFrame {
  type: "resume";
  since: number;
}

export type PhoneFrame = AuthFrame | RpcRequestFrame | ServersFrame | ResumeFrame;

// relay → phone
export interface ReadyFrame {
  type: "ready";
  device: string;
  servers: RelayServer[];
  seq: number;
}

export interface RpcResultFrame {
  type: "rpc-result";
  id: string;
  result?: unknown;
  error?: unknown;
}

export interface EventFrame {
  type: "event";
  seq: number;
  server: string;
  msg: RelayMessage;
}

export type RelayFrame = ReadyFrame | RpcResultFrame | EventFrame;

// `msg` payload of an event frame: an app-server message relayed verbatim.
export interface RelayMessage {
  method: string;
  params?: Record<string, unknown>;
}

export interface SessionEventParams {
  type: string;
  payload?: Record<string, unknown>;
  seq?: number;
  sessionId?: string;
  turnId?: string;
  timestamp?: number;
  deliveryKind?: string;
  eventId?: string;
}

export interface StateUpdatedParams {
  patch?: { status?: string };
  sessionId?: string;
  reason?: string;
}

// Observed session event payload fields (see fixtures/README.md).
export interface TurnStartedPayload {
  turnNumber?: number;
  input?: string;
  messageId?: string;
}

export interface ModelStreamingPayload {
  kind?: string; // text_delta | reasoning_delta | ...
  delta?: string;
  done?: boolean;
  assistantMessageId?: string;
}

export interface ToolUpdatedPayload {
  kind?: string; // scheduled | started | result | ...
  toolCallId?: string;
  toolName?: string;
}

export interface TurnCompletedPayload {
  response?: string;
  resultType?: string;
  duration?: number;
  usage?: Record<string, unknown>;
  error?: unknown;
}

export interface TitleUpdatedPayload {
  title?: string;
}

export interface CheckpointPayload {
  checkpointId?: string;
  fileCount?: number;
}
