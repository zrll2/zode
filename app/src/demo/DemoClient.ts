import type { RelayStatus } from "../relay/client";
import type { RelayMessage, RelayServer } from "../relay/protocol";
import {
  buildSessionList,
  demoHistory,
  DEMO_REPLY,
  DEMO_SERVERS,
  initialDemoSessions,
  RUNNING_SESSION_ID,
  RUNNING_TURN_INPUT,
  RUNNING_TURN_TEXT,
  type DemoSessionRecord,
} from "./data";

// The surface src/useRelay.tsx needs from a client. RelayClient satisfies
// this structurally; DemoClient implements it with sample data.
export interface RelayClientLike {
  status: RelayStatus;
  servers: RelayServer[];
  authFailed: boolean;
  connect(): Promise<void>;
  rpc<T = unknown>(method: string, params?: unknown, server?: string | number): Promise<T>;
  onEvent(cb: (msg: RelayMessage, seq: number) => void): () => void;
  onStatus(cb: (status: RelayStatus) => void): () => void;
  close(): void;
}

type Timer = ReturnType<typeof setTimeout>;

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

// In-memory client for demo mode: same rpc/onEvent/onStatus interface as the
// relay client, backed by sample data and scripted event streams.
export class DemoClient implements RelayClientLike {
  status: RelayStatus = "connecting";
  servers: RelayServer[] = DEMO_SERVERS;
  authFailed = false;

  private sessions: DemoSessionRecord[] = initialDemoSessions();
  private eventCbs = new Set<(msg: RelayMessage, seq: number) => void>();
  private statusCbs = new Set<(status: RelayStatus) => void>();
  private sessionTimers = new Map<string, Timer[]>();
  private runningStarted = new Set<string>();
  private turnNumbers = new Map<string, number>();
  private newSessionCount = 0;
  private seq = 0;

  connect(): Promise<void> {
    this.status = "connecting";
    this.emitStatus();
    this.status = "ready";
    this.emitStatus();
    return Promise.resolve();
  }

  rpc<T = unknown>(method: string, params?: unknown, _server?: string | number): Promise<T> {
    const request = (params ?? {}) as Record<string, any>;
    switch (method) {
      case "session/list":
        return Promise.resolve({
          sessions: buildSessionList(this.sessions, Date.now()),
        } as T);
      case "session/messages":
        return Promise.resolve({
          messages: demoHistory(String(request.sessionId ?? ""), Date.now()),
        } as T);
      case "session/create":
        return Promise.resolve({ session: { sessionId: this.createSession(request) } } as T);
      case "session/resume":
      case "session/subscribe": {
        this.maybeStartRunningTurn(String(request.sessionId ?? ""));
        return Promise.resolve({} as T);
      }
      case "session/send": {
        this.startScriptedTurn(String(request.sessionId ?? ""), String(request.content ?? ""));
        return Promise.resolve({} as T);
      }
      case "session/stop": {
        this.stopTurn(String(request.sessionId ?? ""));
        return Promise.resolve({} as T);
      }
      default:
        return Promise.resolve({} as T);
    }
  }

  onEvent(cb: (msg: RelayMessage, seq: number) => void): () => void {
    this.eventCbs.add(cb);
    return () => {
      this.eventCbs.delete(cb);
    };
  }

  onStatus(cb: (status: RelayStatus) => void): () => void {
    this.statusCbs.add(cb);
    cb(this.status);
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  close(): void {
    for (const timers of this.sessionTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.sessionTimers.clear();
    this.status = "closed";
  }

  private find(sessionId: string): DemoSessionRecord | undefined {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  private emitStatus() {
    for (const cb of this.statusCbs) cb(this.status);
  }

  private emitEvent(sessionId: string, type: string, payload: Record<string, unknown>) {
    this.seq += 1;
    const msg: RelayMessage = {
      method: "session/event",
      params: {
        type,
        payload,
        sessionId,
        turnId: `turn-${sessionId}-${this.turnNumbers.get(sessionId) ?? 0}`,
        timestamp: Date.now(),
      },
    };
    for (const cb of this.eventCbs) cb(msg, this.seq);
  }

  private createSession(request: Record<string, any>): string {
    this.newSessionCount += 1;
    const workspacePath = String(request?.workspace?.workspacePath ?? "");
    const folder = workspacePath.split("/").filter(Boolean).pop() ?? "web-app";
    const sessionId = `demo-new-${this.newSessionCount}`;
    this.sessions.unshift({
      sessionId,
      title: "New session",
      folder,
      status: "idle",
      minutesAgo: 0,
      updatedAt: Date.now(),
    });
    return sessionId;
  }

  // The "running" sample session starts its never-ending turn when the chat
  // screen subscribes, and only stops when the user stops it.
  private maybeStartRunningTurn(sessionId: string) {
    const session = this.find(sessionId);
    if (!session || sessionId !== RUNNING_SESSION_ID) return;
    if (session.status !== "running" || this.runningStarted.has(sessionId)) return;
    this.runningStarted.add(sessionId);
    this.beginTurn(sessionId, {
      input: RUNNING_TURN_INPUT,
      reply: RUNNING_TURN_TEXT,
      complete: false,
    });
  }

  private startScriptedTurn(sessionId: string, input: string) {
    const session = this.find(sessionId);
    if (!session) return;
    session.status = "running";
    session.updatedAt = Date.now();
    this.beginTurn(sessionId, { input, reply: DEMO_REPLY, complete: true });
  }

  private beginTurn(
    sessionId: string,
    options: { input: string; reply: string; complete: boolean },
  ) {
    const turnNumber = (this.turnNumbers.get(sessionId) ?? 0) + 1;
    this.turnNumbers.set(sessionId, turnNumber);
    this.emitEvent(sessionId, "turn.started", { input: options.input, turnNumber });

    const timers: Timer[] = this.sessionTimers.get(sessionId) ?? [];
    this.sessionTimers.set(sessionId, timers);
    const schedule = (delay: number, fn: () => void) => {
      timers.push(setTimeout(fn, delay));
    };

    const toolCallId = `call-demo-${sessionId}-${turnNumber}`;
    let delay = 120;
    const chunks = chunkText(options.reply, 8);
    chunks.forEach((chunk, index) => {
      schedule(delay, () =>
        this.emitEvent(sessionId, "model.streaming", {
          kind: "text_delta",
          delta: chunk,
          done: false,
        }),
      );
      delay += 40;
      if (index === 2 && options.complete) {
        schedule(delay, () =>
          this.emitEvent(sessionId, "tool.updated", { toolCallId, toolName: "Read", kind: "scheduled" }),
        );
        schedule(delay + 80, () =>
          this.emitEvent(sessionId, "tool.updated", { toolCallId, toolName: "Read", kind: "started" }),
        );
        schedule(delay + 180, () =>
          this.emitEvent(sessionId, "tool.updated", { toolCallId, toolName: "Read", kind: "result" }),
        );
        delay += 260;
      }
    });
    if (options.complete) {
      schedule(delay + 120, () => {
        this.emitEvent(sessionId, "turn.completed", {
          response: options.reply,
          resultType: "success",
        });
        this.markIdle(sessionId);
        this.sessionTimers.delete(sessionId);
      });
    }
  }

  private stopTurn(sessionId: string) {
    const timers = this.sessionTimers.get(sessionId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.sessionTimers.delete(sessionId);
    this.emitEvent(sessionId, "turn.completed", { resultType: "stopped" });
    this.markIdle(sessionId);
  }

  private markIdle(sessionId: string) {
    const session = this.find(sessionId);
    if (session) {
      session.status = "idle";
      session.updatedAt = Date.now();
    }
  }
}
