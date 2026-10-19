import type {
  AuthFrame,
  PhoneFrame,
  RelayFrame,
  RelayMessage,
  RelayServer,
  RpcRequestFrame,
} from "./protocol";
import { nextDelay } from "./backoff";

export type RelayStatus = "connecting" | "ready" | "reconnecting" | "closed";

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RelaySocket;

export interface RelayClientOptions {
  url: string;
  token: string;
  createSocket?: SocketFactory;
  rpcTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedEvent {
  msg: RelayMessage;
  seq: number;
}

const AUTH_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 30_000;
const EVENT_BUFFER_LIMIT = 500;

export class RelayClient {
  status: RelayStatus = "closed";
  authFailed = false;
  servers: RelayServer[] = [];
  // Epoch time of the next automatic reconnect while status is
  // "reconnecting", else null. retryNow() skips the wait.
  retryAt: number | null = null;

  private readonly url: string;
  private readonly token: string;
  private readonly createSocket: SocketFactory;
  private readonly rpcTimeoutMs: number;

  private socket: RelaySocket | null = null;
  private lastSeq: number | null = null;
  private attempts = 0;
  private stopped = true;
  private connectPromise: Promise<void> | null = null;

  private pending = new Map<string, Pending>();
  private buffer: BufferedEvent[] = [];
  private eventCbs = new Set<(msg: RelayMessage, seq: number) => void>();
  private statusCbs = new Set<(status: RelayStatus) => void>();

  private rpcCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private connectGuard: ReturnType<typeof setTimeout> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as RelaySocket);
  }

  // Resolves when the first `ready` frame arrives; rejects on 4003 or after
  // CONNECT_TIMEOUT_MS. Reconnection continues in the background either way.
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.stopped = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectGuard = setTimeout(() => {
      this.rejectConnect?.(new Error("relay: timed out waiting for ready"));
    }, CONNECT_TIMEOUT_MS);
    this.openSocket();
    return this.connectPromise;
  }

  rpc<T = unknown>(method: string, params?: unknown, server?: string | number): Promise<T> {
    const socket = this.socket;
    if (!socket || this.status !== "ready") {
      return Promise.reject(new Error(`relay: not connected (${this.status})`));
    }
    const id = `r${++this.rpcCounter}`;
    const frame: RpcRequestFrame = { type: "rpc", id, method, params: params ?? {} };
    if (server !== undefined) frame.server = server;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`relay: ${method} timed out`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(frame);
    });
  }

  // New subscribers first receive the bounded buffer of events seen so far,
  // so a screen opened later still gets the current turn.
  onEvent(cb: (msg: RelayMessage, seq: number) => void): () => void {
    this.eventCbs.add(cb);
    for (const entry of this.buffer) cb(entry.msg, entry.seq);
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

  refreshServers(): void {
    this.send({ type: "servers" });
  }

  // User-triggered immediate reconnect: clears the pending timer and opens a
  // socket now. Attempt counter and backoff schedule stay untouched.
  retryNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retryAt = null;
    if (!this.stopped && !this.socket) this.openSocket();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retryAt = null;
    if (this.connectGuard) {
      clearTimeout(this.connectGuard);
      this.connectGuard = null;
    }
    this.rejectConnect?.(new Error("relay: closed before ready"));
    this.failPending(new Error("relay: closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "client close");
      } catch {}
    }
    this.setStatus("closed");
  }

  private openSocket() {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.authTimer = setTimeout(() => {
        try {
          socket.close(4000, "auth timeout");
        } catch {}
      }, AUTH_TIMEOUT_MS);
      const frame: AuthFrame = { type: "auth", token: this.token };
      if (this.lastSeq !== null) frame.since = this.lastSeq;
      this.send(frame);
    };
    socket.onmessage = (ev) => this.handleData(ev.data);
    socket.onerror = () => {
      // onclose drives reconnection
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.handleClose(ev?.code);
    };
  }

  private handleClose(code?: number) {
    this.socket = null;
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.connectGuard) {
      clearTimeout(this.connectGuard);
      this.connectGuard = null;
    }
    this.failPending(new Error("relay: disconnected"));
    if (this.stopped) {
      this.setStatus("closed");
      return;
    }
    if (code === 4003) {
      this.authFailed = true;
      this.stopped = true;
      this.rejectConnect?.(new Error("relay: pairing rejected (bad token)"));
      this.setStatus("closed");
      return;
    }
    const delay = nextDelay(this.attempts);
    this.attempts += 1;
    this.retryAt = Date.now() + delay;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryAt = null;
      if (!this.stopped) this.openSocket();
    }, delay);
  }

  private handleData(data: unknown) {
    if (typeof data !== "string") return;
    let frame: RelayFrame;
    try {
      frame = JSON.parse(data) as RelayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "ready") {
      if (this.authTimer) {
        clearTimeout(this.authTimer);
        this.authTimer = null;
      }
      this.attempts = 0;
      if (this.lastSeq === null && typeof frame.seq === "number") this.lastSeq = frame.seq;
      this.servers = Array.isArray(frame.servers) ? frame.servers : [];
      if (this.connectGuard) {
        clearTimeout(this.connectGuard);
        this.connectGuard = null;
      }
      this.resolveConnect?.();
      this.setStatus("ready");
    } else if (frame.type === "rpc-result") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined && frame.error !== null) {
        pending.reject(new Error(errorText(frame.error)));
      } else {
        pending.resolve(frame.result);
      }
    } else if (frame.type === "event") {
      if (typeof frame.seq !== "number") return;
      if (this.lastSeq !== null && frame.seq <= this.lastSeq) return; // duplicate or replay
      this.lastSeq = frame.seq;
      const entry: BufferedEvent = { msg: frame.msg, seq: frame.seq };
      this.buffer.push(entry);
      if (this.buffer.length > EVENT_BUFFER_LIMIT) this.buffer.shift();
      for (const cb of this.eventCbs) cb(entry.msg, entry.seq);
    }
  }

  private failPending(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private send(frame: PhoneFrame) {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {}
  }

  private setStatus(status: RelayStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusCbs) cb(status);
  }
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const anyErr = err as { message?: unknown; error?: unknown };
    if (typeof anyErr.message === "string") return anyErr.message;
    if (anyErr.error !== undefined) return errorText(anyErr.error);
  }
  return "Unknown relay error";
}
