import type { RelayMessage } from "./protocol";

export type ChatItemKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";

export interface ChatItem {
  key: string;
  kind: ChatItemKind;
  text: string;
  streaming?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolState?: string;
  timestamp?: number;
}

export interface PermissionRequest {
  toolName?: string;
  message: string;
}

export interface SessionState {
  sessionId: string | null;
  title: string | null;
  items: ChatItem[];
  running: boolean;
  lastResponse: string | null;
  permissionRequest: PermissionRequest | null;
  counter: number;
}

export function initialSessionState(sessionId: string | null = null): SessionState {
  return {
    sessionId,
    title: null,
    items: [],
    running: false,
    lastResponse: null,
    permissionRequest: null,
    counter: 0,
  };
}

// Pure reducer: one session's relay messages -> chat state.
// Events bound to a different sessionId are ignored.
export function reduce(state: SessionState, msg: RelayMessage): SessionState {
  if (!msg || typeof msg.method !== "string") return state;
  const params = (msg.params ?? {}) as Record<string, any>;
  const evSession = typeof params.sessionId === "string" ? params.sessionId : null;
  if (state.sessionId && evSession && evSession !== state.sessionId) return state;

  if (msg.method === "state.updated") {
    const status = params.patch?.status;
    if (status === "running") return { ...state, running: true };
    if (status === "idle") return { ...state, running: false };
    return state;
  }
  if (msg.method !== "session/event") return state;

  const type = typeof params.type === "string" ? params.type : "";
  const payload = (params.payload ?? {}) as Record<string, any>;
  const timestamp = typeof params.timestamp === "number" ? params.timestamp : undefined;

  switch (type) {
    case "turn.started": {
      let counter = state.counter;
      const items = state.items.map((i) => (i.streaming ? { ...i, streaming: false } : i));
      const input =
        typeof payload.input === "string" && payload.input.trim()
          ? payload.input.trim()
          : typeof payload.intent?.text === "string" && payload.intent.text.trim()
            ? payload.intent.text.trim()
            : null;
      if (input) items.push({ key: `u${++counter}`, kind: "user", text: input, timestamp });
      return { ...state, items, counter, running: true, permissionRequest: null };
    }

    case "model.streaming": {
      if (typeof payload.delta !== "string") return state;
      const kind: ChatItemKind = payload.kind === "reasoning_delta" ? "reasoning" : "assistant";
      let counter = state.counter;
      const items = [...state.items];
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === kind && items[i].streaming) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          text: items[idx].text + payload.delta,
          streaming: payload.done !== true,
        };
      } else {
        items.push({
          key: `s${++counter}`,
          kind,
          text: payload.delta,
          streaming: payload.done !== true,
          timestamp,
        });
      }
      return { ...state, items, counter };
    }

    case "tool.updated": {
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      if (!toolCallId) return state;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
      const toolState = typeof payload.kind === "string" ? payload.kind : undefined;
      const items = [...state.items];
      const idx = items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId);
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          toolName: toolName ?? items[idx].toolName,
          toolState: toolState ?? items[idx].toolState,
        };
      } else {
        items.push({
          key: `t-${toolCallId}`,
          kind: "tool",
          text: "",
          toolCallId,
          toolName,
          toolState,
          timestamp,
        });
      }
      return { ...state, items };
    }

    case "checkpoint.created": {
      const count = typeof payload.fileCount === "number" ? payload.fileCount : null;
      const text =
        count === null ? "Checkpoint saved" : `Checkpoint saved (${count} file${count === 1 ? "" : "s"})`;
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "notice" && last.text === text) return state;
      const counter = state.counter + 1;
      return {
        ...state,
        counter,
        items: [...state.items, { key: `n${counter}`, kind: "notice", text, timestamp }],
      };
    }

    case "session.titleUpdated": {
      if (typeof payload.title !== "string" || !payload.title) return state;
      return { ...state, title: payload.title };
    }

    case "turn.completed": {
      let counter = state.counter;
      let items = state.items.map((i) => (i.streaming ? { ...i, streaming: false } : i));
      const response = typeof payload.response === "string" ? payload.response : null;
      if (response !== null) {
        const idx = lastIndexOfKind(items, "assistant");
        if (idx >= 0) {
          items[idx] = { ...items[idx], text: response, streaming: false };
        } else {
          items.push({
            key: `a${++counter}`,
            kind: "assistant",
            text: response,
            streaming: false,
            timestamp,
          });
        }
      }
      const errText = extractError(type, payload);
      if (errText) {
        items = appendError(items, errText, () => `e${++counter}`, timestamp);
      }
      return {
        ...state,
        items,
        counter,
        running: false,
        lastResponse: response ?? state.lastResponse,
        permissionRequest: null,
      };
    }

    default: {
      const errText = extractError(type, payload);
      if (errText) {
        let counter = state.counter;
        const items = appendError(
          state.items.map((i) => (i.streaming ? { ...i, streaming: false } : i)),
          errText,
          () => `e${++counter}`,
          timestamp,
        );
        return { ...state, items, counter, running: false };
      }
      if (isPermissionEvent(type, payload)) {
        const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
        const message =
          typeof payload.message === "string" && payload.message
            ? payload.message
            : `Permission requested${toolName ? ` for ${toolName}` : ""}`;
        return { ...state, permissionRequest: { toolName, message } };
      }
      return state;
    }
  }
}

function lastIndexOfKind(items: ChatItem[], kind: ChatItemKind): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === kind) return i;
  }
  return -1;
}

function appendError(
  items: ChatItem[],
  text: string,
  nextKey: () => string,
  timestamp?: number,
): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "error" && last.text === text) return items;
  return [...items, { key: nextKey(), kind: "error", text, timestamp }];
}

// Failed turns surface as an `error` in the payload, or an error-ish event
// type carrying a message, or a non-success resultType.
function extractError(type: string, payload: Record<string, any>): string | null {
  const err = payload.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const message = (err as Record<string, any>).message;
    if (typeof message === "string" && message) return message;
  }
  if (/error|failed|failure/i.test(type)) {
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.reason === "string" && payload.reason) return payload.reason;
  }
  if (typeof payload.resultType === "string" && payload.resultType !== "success") {
    if (typeof payload.message === "string" && payload.message) return payload.message;
    return `Turn failed (${payload.resultType})`;
  }
  return null;
}

function isPermissionEvent(type: string, payload: Record<string, any>): boolean {
  if (/permission/i.test(type)) return true;
  return payload.permissionRequest != null;
}
