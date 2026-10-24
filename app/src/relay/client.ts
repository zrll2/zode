import type {
  AuthFrame,
  PhoneFrame,
  RelayFrame,
  RelayMessage,
  RelayServer,
  RpcRequestFrame,
} from "./protocol";
import { nextDelay } from "./backoff";
import { reduceApprovals, type ApprovalRequest } from "../approvals";
import { sanitizeUrlList } from "../pairing";

export type RelayStatus = "connecting" | "ready" | "reconnecting" | "closed";

export interface RespondResult {
  ok: boolean;
  message?: string;
}

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
  // Every known relay address (url included). The client races them and
  // keeps whichever delivers ready first.
  urls?: string[];
  // Last good address; it gets a head start in every race.
  preferred?: string;
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
const RESPOND_TIMEOUT_MS = 10_000;
const EVENT_BUFFER_LIMIT = 500;
// The preferred address races alone for this long before the rest join.
const HEAD_START_MS = 2_500;
const STAGGER_MS = 300;
const URLS_CAP = 8;

export class RelayClient {
  status: RelayStatus = "closed";
  authFailed = false;
  servers: RelayServer[] = [];
  // Protocol version the relay announced in its ready frame; undefined when
  // the relay is older and does not announce one (treated as protocol 1).
  private relayProtocolValue: number | undefined = undefined;
  // Optional features the relay announced, e.g. { stt: true }.
  private relayFeaturesValue: { stt: boolean } = { stt: false };
  // Epoch time of the next automatic reconnect while status is
  // "reconnecting", else null. retryNow() skips the wait.
  retryAt: number | null = null;

  private urlsValue: string[];
  private preferred: string | null;
  private readonly token: string;
  private readonly createSocket: SocketFactory;
  private readonly rpcTimeoutMs: number;

  private socket: RelaySocket | null = null; // the race winner
  private racers = new Map<RelaySocket, string>();
  private raceSettled = true;
  private raceTimers: ReturnType<typeof setTimeout>[] = [];
  private roundSize = 0;
  private launchedCount = 0;
  private lastSeq: number | null = null;
  private attempts = 0;
  private stopped = true;
  private connectPromise: Promise<void> | null = null;

  private pending = new Map<string, Pending>();
  private buffer: BufferedEvent[] = [];
  private eventCbs = new Set<(msg: RelayMessage, seq: number) => void>();
  private statusCbs = new Set<(status: RelayStatus) => void>();
  private approvalCbs = new Set<(list: ApprovalRequest[]) => void>();
  private connectedCbs = new Set<(url: string, addresses: string[] | null) => void>();
  // Approval requests waiting on this phone (Ask first mode). Only emitted
  // when the set of keys actually changes.
  private approvalsValue: ApprovalRequest[] = [];
  private approvalsKeys = "";

  private rpcCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectGuard: ReturnType<typeof setTimeout> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;

  constructor(options: RelayClientOptions) {
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const entry of options.urls && options.urls.length ? options.urls : [options.url]) {
      if (typeof entry !== "string" || !entry || seen.has(entry)) continue;
      seen.add(entry);
      urls.push(entry);
      if (urls.length >= URLS_CAP) break;
    }
    if (!seen.has(options.url)) urls.unshift(options.url);
    this.urlsValue = urls;
    this.preferred =
      typeof options.preferred === "string" && seen.has(options.preferred)
        ? options.preferred
        : null;
    this.token = options.token;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as RelaySocket);
  }

  get relayProtocol(): number | undefined {
    return this.relayProtocolValue;
  }

  get relayFeatures(): { stt: boolean } {
    return this.relayFeaturesValue;
  }

  get pendingApprovals(): ApprovalRequest[] {
    return this.approvalsValue;
  }

  // Current candidate list, preferred first (what the next race will try).
  get candidateUrls(): string[] {
    return this.candidateOrder();
  }

  onApprovals(cb: (list: ApprovalRequest[]) => void): () => void {
    this.approvalCbs.add(cb);
    cb(this.approvalsValue);
    return () => {
      this.approvalCbs.delete(cb);
    };
  }

  // Fires once per ready frame with the winning address and the relay's
  // address list (null when the relay is too old to send one).
  onConnected(cb: (url: string, addresses: string[] | null) => void): () => void {
    this.connectedCbs.add(cb);
    return () => {
      this.connectedCbs.delete(cb);
    };
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

  rpc<T = unknown>(
    method: string,
    params?: unknown,
    server?: string | number,
    timeoutMs?: number,
  ): Promise<T> {
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
      }, timeoutMs ?? this.rpcTimeoutMs);
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
    // A fresh client is "closed" before its first connect; don't lead with it.
    if (this.status !== "closed") cb(this.status);
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  // Answers a pending permission request. Never rejects: the result says ok
  // or carries the relay's calm failure message.
  respond(
    server: string,
    id: string,
    decision: "allow" | "deny",
    reason?: string,
  ): Promise<RespondResult> {
    if (!this.socket || this.status !== "ready") {
      return Promise.resolve({ ok: false, message: "Not connected." });
    }
    const rid = `r${++this.rpcCounter}`;
    const frame = {
      type: "respond",
      rid,
      server,
      id,
      decision,
      ...(reason !== undefined ? { reason } : {}),
    };
    return new Promise<RespondResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({ ok: false, message: "Couldn't reach your Mac. Try again." });
      }, RESPOND_TIMEOUT_MS);
      this.pending.set(rid, {
        resolve: () => resolve({ ok: true }),
        reject: (err: Error) => resolve({ ok: false, message: err.message }),
        timer,
      });
      this.send(frame as unknown as PhoneFrame);
    });
  }

  private setApprovals(next: ApprovalRequest[]) {
    this.approvalsValue = next;
    const keys = next.map((request) => request.key).join("|");
    if (keys === this.approvalsKeys) return;
    this.approvalsKeys = keys;
    for (const cb of this.approvalCbs) cb(next);
  }

  refreshServers(): void {
    this.send({ type: "servers" });
  }

  // User-triggered immediate reconnect: clears the pending timer and starts
  // a new race now. A no-op while connected or while a race is in flight.
  retryNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retryAt = null;
    if (this.stopped || this.socket) return;
    if (!this.raceSettled && this.racers.size > 0) return;
    this.openSocket();
  }

  close(): void {
    this.stopped = true;
    this.relayProtocolValue = undefined;
    this.setApprovals([]);
    this.raceSettled = true;
    this.clearRaceTimers();
    for (const socket of this.racers.keys()) this.closeQuietly(socket);
    this.racers.clear();
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

  private candidateOrder(): string[] {
    if (!this.preferred || !this.urlsValue.includes(this.preferred)) return [...this.urlsValue];
    return [this.preferred, ...this.urlsValue.filter((url) => url !== this.preferred)];
  }

  private clearRaceTimers() {
    for (const timer of this.raceTimers) clearTimeout(timer);
    this.raceTimers = [];
  }

  private closeQuietly(socket: RelaySocket) {
    try {
      socket.close(1000, "lost race");
    } catch {}
  }

  // One connection round: the preferred url races alone with a head start,
  // then the rest join staggered. The first ready wins.
  private openSocket() {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    this.raceSettled = false;
    this.racers.clear();
    this.launchedCount = 0;
    const order = this.candidateOrder();
    this.roundSize = order.length;

    const launch = (url: string) => {
      if (this.raceSettled || this.stopped) return;
      this.launchedCount += 1;
      const socket = this.createSocket(url);
      this.racers.set(socket, url);
      socket.onopen = () => {
        this.raceTimers.push(
          setTimeout(() => {
            try {
              socket.close(4000, "auth timeout");
            } catch {}
          }, AUTH_TIMEOUT_MS),
        );
        const frame: AuthFrame = { type: "auth", token: this.token };
        if (this.lastSeq !== null) frame.since = this.lastSeq;
        this.sendOn(socket, frame);
      };
      socket.onmessage = (ev) => this.handleData(socket, url, ev.data);
      socket.onerror = () => {
        // onclose drives the outcome
      };
      socket.onclose = (ev) => this.handleRacerClose(socket, ev?.code);
    };

    order.forEach((url, index) => {
      if (index === 0) {
        launch(url);
        return;
      }
      const delay = HEAD_START_MS + (index - 1) * STAGGER_MS;
      this.raceTimers.push(
        setTimeout(() => {
          launch(url);
        }, delay),
      );
    });
  }

  private handleRacerClose(socket: RelaySocket, code?: number) {
    if (socket === this.socket) {
      // The winner dropped after ready: roll straight into a new race.
      this.handleClose(code);
      return;
    }
    if (this.raceSettled) return; // a loser being cleaned up
    this.racers.delete(socket);
    if (code === 4003) {
      // A bad token is bad on every address: stop as today.
      this.raceSettled = true;
      this.clearRaceTimers();
      for (const other of this.racers.keys()) this.closeQuietly(other);
      this.racers.clear();
      this.failPending(new Error("relay: pairing rejected (bad token)"));
      this.authFailed = true;
      this.stopped = true;
      this.rejectConnect?.(new Error("relay: pairing rejected (bad token)"));
      this.setStatus("closed");
      return;
    }
    if (this.racers.size === 0 && this.launchedCount >= this.roundSize) {
      this.handleRoundFailed();
    }
  }

  // Every candidate failed without a ready: fall back to the backoff loop.
  private handleRoundFailed() {
    if (this.raceSettled) return;
    this.raceSettled = true;
    this.clearRaceTimers();
    this.failPending(new Error("relay: disconnected"));
    if (this.stopped) {
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

  private handleClose(code?: number) {
    this.socket = null;
    this.racers.clear();
    this.raceSettled = true;
    this.clearRaceTimers();
    this.relayProtocolValue = undefined;
    this.relayFeaturesValue = { stt: false };
    this.setApprovals([]);
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
    this.openSocket();
  }

  // The first ready ends the race: the winner stays, every other socket is
  // closed at once (their later close events are ignored, so the status
  // never flickers and no reconnect cycle starts).
  private settleRace(winner: RelaySocket) {
    this.raceSettled = true;
    this.clearRaceTimers();
    this.socket = winner;
    for (const [socket] of this.racers) {
      if (socket === winner) continue;
      this.racers.delete(socket);
      this.closeQuietly(socket);
    }
  }

  // The relay re-announces its addresses: replace the list, keeping the
  // winner even if the relay no longer lists it.
  private adoptAddresses(winnerUrl: string, addresses: string[]) {
    const list: string[] = [];
    const seen = new Set<string>();
    const push = (entry: string) => {
      if (seen.has(entry) || list.length >= URLS_CAP) return;
      seen.add(entry);
      list.push(entry);
    };
    for (const entry of addresses) push(entry);
    if (!seen.has(winnerUrl)) push(winnerUrl);
    this.urlsValue = list;
  }

  private handleData(socket: RelaySocket, url: string, data: unknown) {
    if (typeof data !== "string") return;
    let frame: RelayFrame;
    try {
      frame = JSON.parse(data) as RelayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "ready") {
      if (this.socket !== socket) this.settleRace(socket);
      this.attempts = 0;
      const protocol = (frame as { protocol?: unknown }).protocol;
      this.relayProtocolValue = typeof protocol === "number" ? protocol : undefined;
      const features = (frame as { features?: unknown }).features;
      this.relayFeaturesValue = {
        stt: Boolean(
          features &&
            typeof features === "object" &&
            (features as { stt?: unknown }).stt === true,
        ),
      };
      this.setApprovals(reduceApprovals(this.approvalsValue, frame, Date.now()));
      const rawAddresses = (frame as { addresses?: unknown }).addresses;
      const addresses = sanitizeUrlList(rawAddresses);
      if (addresses.length) this.adoptAddresses(url, addresses);
      this.preferred = url;
      if (this.lastSeq === null && typeof frame.seq === "number") this.lastSeq = frame.seq;
      this.servers = Array.isArray(frame.servers) ? frame.servers : [];
      for (const cb of this.connectedCbs) {
        cb(url, addresses.length ? [...this.urlsValue] : null);
      }
      if (this.connectGuard) {
        clearTimeout(this.connectGuard);
        this.connectGuard = null;
      }
      this.resolveConnect?.();
      this.setStatus("ready");
      return;
    }
    if (this.socket !== socket) return; // frames from a losing socket
    if (frame.type === "rpc-result") {
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
      this.setApprovals(reduceApprovals(this.approvalsValue, frame, Date.now()));
    }
  }

  private failPending(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private sendOn(socket: RelaySocket, frame: PhoneFrame) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {}
  }

  private send(frame: PhoneFrame) {
    if (this.socket) this.sendOn(this.socket, frame);
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
