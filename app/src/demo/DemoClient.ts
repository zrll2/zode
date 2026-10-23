import type { RelayStatus, RespondResult } from "../relay/client";
import type { RelayMessage, RelayServer } from "../relay/protocol";
import type { ApprovalRequest } from "../approvals";
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
  retryAt: number | null;
  // Protocol the relay announced (undefined = older relay, protocol 1).
  readonly relayProtocol: number | undefined;
  // Permission requests waiting right now (Ask first mode).
  readonly pendingApprovals: ApprovalRequest[];
  retryNow(): void;
  respond(
    server: string,
    id: string,
    decision: "allow" | "deny",
    reason?: string,
  ): Promise<RespondResult>;
  connect(): Promise<void>;
  rpc<T = unknown>(
    method: string,
    params?: unknown,
    server?: string | number,
    timeoutMs?: number,
  ): Promise<T>;
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
  retryAt: number | null = null; // the demo never reconnects
  // Demo behaves as a current (protocol 2) relay.
  readonly relayProtocol: number | undefined = 2;

  retryNow() {}

  private sessions: DemoSessionRecord[] = initialDemoSessions();
  private eventCbs = new Set<(msg: RelayMessage, seq: number) => void>();
  private statusCbs = new Set<(status: RelayStatus) => void>();
  private approvalCbs = new Set<(list: ApprovalRequest[]) => void>();
  private approvalsValue: ApprovalRequest[] = [];
  private sessionTimers = new Map<string, Timer[]>();
  private runningStarted = new Set<string>();
  private turnNumbers = new Map<string, number>();
  private newSessionCount = 0;
  private seq = 0;
  private demoModelId = "GLM-5.3-Flash";
  private demoLevel = "max";
  private demoMode = "edit";

  connect(): Promise<void> {
    this.status = "connecting";
    this.emitStatus();
    this.status = "ready";
    this.emitStatus();
    this.approvalsValue = [
      {
        key: "101:demo-permission-1",
        server: "101",
        id: "demo-permission-1",
        kind: "permission",
        sessionId: "demo-login-redirect",
        toolName: "Bash",
        summary: "Run: rm -rf dist && npm run build",
        detail: "rm -rf dist && npm run build",
        risky: true,
        at: Date.now(),
      },
    ];
    this.emitApprovals();
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
        return Promise.resolve(this.demoResume() as T);
      case "session/subscribe": {
        this.maybeStartRunningTurn(String(request.sessionId ?? ""));
        return Promise.resolve({} as T);
      }
      case "session/setModel": {
        const model = request.model as
          | { providerId?: unknown; modelId?: unknown; options?: { reasoningLevel?: unknown } }
          | undefined;
        if (typeof model?.modelId === "string" && model.modelId) {
          this.demoModelId = model.modelId;
        }
        if (typeof model?.options?.reasoningLevel === "string") {
          this.demoLevel = model.options.reasoningLevel;
        }
        return Promise.resolve({ status: "accepted" } as T);
      }
      case "session/setThoughtLevel": {
        const level = String(request.thoughtLevel ?? "");
        if (level) this.demoLevel = level;
        return Promise.resolve({ status: "accepted" } as T);
      }
      case "session/rename": {
        const id = String(request.sessionId ?? "");
        const title = String(request.title ?? "").slice(0, 120);
        const renamed = this.find(id);
        if (renamed) {
          renamed.title = title;
          this.emitEvent(id, "session.titleUpdated", { title });
        }
        return Promise.resolve({ status: "accepted" } as T);
      }
      case "session/usage":
        return Promise.resolve({
          sessionId: String(request.sessionId ?? ""),
          totalTokens: 465_541,
          inputTokens: 465_176,
          outputTokens: 365,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 322_368,
          modelRequestCount: 3,
          modelErrorCount: 0,
        } as T);
      case "usage/stats":
        return Promise.resolve(this.demoAccountUsage(Date.now()) as T);
      case "session/send": {
        this.startScriptedTurn(String(request.sessionId ?? ""), String(request.content ?? ""));
        return Promise.resolve({} as T);
      }
      case "session/stop": {
        this.stopTurn(String(request.sessionId ?? ""));
        return Promise.resolve({} as T);
      }
      case "attachment/upload": {
        this.seq += 1;
        const bytes = Math.round(String(request.dataBase64 ?? "").length * 0.75);
        return Promise.resolve({
          ref: `demo-att-${this.seq}`,
          fileName: String(request.fileName ?? "file"),
          mime: String(request.mime ?? "application/octet-stream"),
          bytes,
        } as T);
      }
      case "session/setMode": {
        const mode = String(request.mode ?? "");
        if (["plan", "edit", "guarded", "build", "yolo", "auto"].includes(mode)) {
          this.demoMode = mode;
        }
        return Promise.resolve({ status: "accepted" } as T);
      }
      default:
        return Promise.resolve({} as T);
    }
  }

  get pendingApprovals(): ApprovalRequest[] {
    return this.approvalsValue;
  }

  onApprovals(cb: (list: ApprovalRequest[]) => void): () => void {
    this.approvalCbs.add(cb);
    cb(this.approvalsValue);
    return () => {
      this.approvalCbs.delete(cb);
    };
  }

  // The sample request resolves a moment after the decision.
  respond(
    _server: string,
    id: string,
    _decision: "allow" | "deny",
    _reason?: string,
  ): Promise<RespondResult> {
    if (!this.approvalsValue.some((request) => request.id === id)) {
      return Promise.resolve({ ok: false, message: "request is not pending (already answered?)" });
    }
    setTimeout(() => {
      this.approvalsValue = [];
      this.emitApprovals();
      this.markIdle("demo-login-redirect");
    }, 400);
    return Promise.resolve({ ok: true });
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
    this.approvalsValue = [];
    this.emitApprovals();
  }

  private find(sessionId: string): DemoSessionRecord | undefined {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  // session/resume result with settings + projection so the chat screens the
  // model/thinking/usage features work in demo mode.
  private demoResume() {
    const providerId = "account:zai-individual-coding-plan";
    const levels = [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" },
    ];
    return {
      settings: {
        mode: { current: this.demoMode },
        model: {
          current: {
            providerId,
            modelId: this.demoModelId,
            options: { reasoningLevel: this.demoLevel },
          },
          available: [
            {
              ref: { providerId, modelId: "GLM-5.3-Flash" },
              label: "GLM-5.3",
              providerLabel: "Z.AI Individual Coding Plan",
              contextWindow: 1_000_000,
              maxOutputTokens: 128_000,
              reasoning: { levels, defaultLevel: "max" },
            },
            {
              ref: { providerId, modelId: "GLM-5.3-Turbo" },
              label: "GLM-5.3 Turbo",
              providerLabel: "Z.AI Individual Coding Plan",
              contextWindow: 1_000_000,
              maxOutputTokens: 64_000,
              reasoning: { levels: levels.slice(0, 2), defaultLevel: "high" },
            },
          ],
        },
        thoughtLevel: {
          available: levels,
          current: this.demoLevel,
          enabled: true,
        },
      },
      projection: {
        contextUsed: 84_000,
        contextWindow: 1_000_000,
        totalTokenCount: 465_541,
        turnCount: 6,
        status: "idle",
        mode: this.demoMode,
      },
    };
  }

  private demoAccountUsage(now: number) {
    const days: ({ date: string; totalTokens: number; turnCount: number } | null)[] = [];
    for (let index = 20; index >= 0; index -= 1) {
      const date = new Date(now - index * 86_400_000);
      if (index % 7 === 3) {
        days.push(null);
      } else {
        days.push({
          date: date.toISOString().slice(0, 10),
          totalTokens: 120_000 + ((index * 7_919) % 380_000),
          turnCount: 2 + (index % 4),
        });
      }
    }
    const weeks = [];
    for (let start = 0; start < days.length; start += 7) {
      weeks.push({ days: days.slice(start, start + 7) });
    }
    return {
      range: "30d",
      generatedAt: new Date(now).toISOString(),
      summary: {
        totalTokens: 5_662_760_401,
        inputTokens: 4_900_000_000,
        outputTokens: 640_000_000,
        cacheReadTokens: 3_100_000_000,
        cacheHitRate: 0.62,
        totalSessions: 148,
        totalTurns: 1_204,
        toolCallCount: 6_512,
        toolErrorRate: 0.02,
        activeDays: 41,
        favoriteModel: { modelId: "GLM-5.3-Flash", totalTokens: 4_100_000_000, share: 0.72 },
      },
      heatmap: { weeks },
      dailyModelUsage: [],
    };
  }

  private emitStatus() {
    for (const cb of this.statusCbs) cb(this.status);
  }

  private emitApprovals() {
    for (const cb of this.approvalCbs) cb(this.approvalsValue);
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
