import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { friendlyError } from "./friendlyError";
import * as Linking from "expo-linking";
import { RelayClient, type RelayStatus, type RespondResult } from "./relay/client";
import type { ApprovalRequest } from "./approvals";
import type { RelayMessage, RelayServer } from "./relay/protocol";
import { initialSessionState, reduce, type SessionState } from "./relay/reducer";
import { DemoClient, type RelayClientLike } from "./demo/DemoClient";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./storage";

interface RelayContextValue {
  hydrated: boolean;
  credentials: Credentials | null;
  client: RelayClientLike | null;
  status: RelayStatus;
  authFailed: boolean;
  servers: RelayServer[];
  lastError: string | null;
  demo: boolean;
  retryAt: number | null;
  reconnectAttempts: number;
  // Protocol the relay announced in its ready frame; undefined means an
  // older Zode on the Mac (treated as protocol 1). See src/compat.ts.
  relayProtocol: number | undefined;
  // Optional features the relay announced (V3/PS3): stt enables voice, push
  // enables remote notifications.
  relayFeatures: { stt: boolean; push: boolean };
  // Ask-first permission requests waiting right now (see src/approvals.ts).
  pendingApprovals: ApprovalRequest[];
  // The address the current connection actually uses, for diagnostics.
  connectedUrl: string | null;
  connect(credentials: Credentials): void;
  startDemo(): void;
  exitDemo(): Promise<void>;
  unpair(): Promise<void>;
  retryNow(): void;
  rpc<T = unknown>(method: string, params?: unknown, server?: string | number): Promise<T>;
  respondApproval(key: string, decision: "allow" | "deny"): Promise<RespondResult>;
}

const RelayContext = createContext<RelayContextValue | null>(null);

export function RelayProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [client, setClient] = useState<RelayClientLike | null>(null);
  const [status, setStatus] = useState<RelayStatus>("closed");
  const [authFailed, setAuthFailed] = useState(false);
  const [servers, setServers] = useState<RelayServer[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [relayProtocol, setRelayProtocol] = useState<number | undefined>(undefined);
  const [relayFeatures, setRelayFeatures] = useState<{ stt: boolean; push: boolean }>({
    stt: false,
    push: false,
  });
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);
  const clientRef = useRef<RelayClientLike | null>(null);
  // Mirrors credentials so the address-merge callback never reads stale state.
  const credsRef = useRef<Credentials | null>(null);

  // Returning to the foreground re-races the addresses right away when the
  // connection is down; a live connection is left alone (no hunting).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") clientRef.current?.retryNow();
    });
    return () => subscription.remove();
  }, []);

  // While reconnecting, mirror the client's next-try time and count how many
  // attempts in a row failed (the banner offers "Retry now" from the third).
  const lastRetryAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== "reconnecting") {
      lastRetryAtRef.current = null;
      setReconnectAttempts(0);
      setRetryAt(null);
      return;
    }
    const sync = () => {
      const current = clientRef.current?.retryAt ?? null;
      setRetryAt(current);
      if (current !== null && current !== lastRetryAtRef.current) {
        lastRetryAtRef.current = current;
        setReconnectAttempts((count) => count + 1);
      }
      if (current === null) lastRetryAtRef.current = null;
    };
    sync();
    const id = setInterval(sync, 500);
    return () => clearInterval(id);
  }, [status]);

  const retryNow = useCallback(() => {
    clientRef.current?.retryNow();
    setRetryAt(clientRef.current?.retryAt ?? null);
  }, []);

  const attachReal = useCallback((creds: Credentials) => {
    clientRef.current?.close();
    const next = new RelayClient({
      url: creds.wsUrl,
      urls: creds.wsUrls,
      preferred: creds.lastGood,
      token: creds.token,
    });
    credsRef.current = creds;
    clientRef.current = next;
    next.onStatus((s) => {
      setStatus(s);
      setServers([...next.servers]);
      setRelayProtocol(next.relayProtocol);
      setRelayFeatures(next.relayFeatures);
    });
    next.onApprovals((list) => setPendingApprovals(list));
    // Learn from every ready: remember the winner and, when the relay
    // re-announces its addresses, replace the stored list.
    next.onConnected((url, addresses) => {
      if (clientRef.current !== next) return;
      setConnectedUrl(url);
      const base = credsRef.current;
      if (!base) return;
      const wsUrls = addresses ?? base.wsUrls;
      if (base.lastGood === url && wsUrls.join("|") === base.wsUrls.join("|")) return;
      const merged: Credentials = { ...base, wsUrls, lastGood: url };
      credsRef.current = merged;
      setCredentials(merged);
      void saveCredentials(merged);
    });
    setAuthFailed(false);
    setLastError(null);
    setDemo(false);
    setConnectedUrl(null);
    setClient(next);
    next.connect().catch((e: any) => {
      setLastError(friendlyError(e));
    });
  }, []);

  const startDemo = useCallback(() => {
    clientRef.current?.close();
    const next = new DemoClient();
    clientRef.current = next;
    next.onStatus((s) => {
      setStatus(s);
      setServers([...next.servers]);
      setRelayProtocol(next.relayProtocol);
      setRelayFeatures(next.relayFeatures);
    });
    next.onApprovals((list) => setPendingApprovals(list));
    setAuthFailed(false);
    setLastError(null);
    setDemo(true);
    setClient(next);
    void next.connect().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const creds = await loadCredentials();
      const envDemo = process.env.EXPO_PUBLIC_ZODE_DEMO === "1";
      let linkDemo = false;
      try {
        const initialUrl = await Linking.getInitialURL();
        linkDemo = Boolean(initialUrl && initialUrl.includes("zode://demo"));
      } catch {}
      if (cancelled) return;
      if (creds) {
        setCredentials(creds);
        attachReal(creds);
      }
      if (envDemo || linkDemo) startDemo();
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [attachReal, startDemo]);

  // A zode://demo link also starts the demo while the app is running.
  useEffect(() => {
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (url.includes("zode://demo")) startDemo();
    });
    return () => subscription.remove();
  }, [startDemo]);

  const connect = useCallback(
    (creds: Credentials) => {
      credsRef.current = creds;
      setCredentials(creds);
      void saveCredentials(creds);
      attachReal(creds);
    },
    [attachReal],
  );

  const exitDemo = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    setDemo(false);
    setStatus("closed");
    setServers([]);
    setRelayProtocol(undefined);
    setRelayFeatures({ stt: false, push: false });
    setPendingApprovals([]);
    setConnectedUrl(null);
  }, []);

  const unpair = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    credsRef.current = null;
    setClient(null);
    await clearCredentials();
    setCredentials(null);
    setDemo(false);
    setStatus("closed");
    setServers([]);
    setAuthFailed(false);
    setLastError(null);
    setRelayProtocol(undefined);
    setRelayFeatures({ stt: false, push: false });
    setPendingApprovals([]);
    setConnectedUrl(null);
  }, []);

  const rpc = useCallback(
    <T,>(method: string, params?: unknown, server?: string | number): Promise<T> => {
      const current = clientRef.current;
      if (!current) return Promise.reject(new Error("Not paired yet."));
      return current.rpc<T>(method, params, server);
    },
    [],
  );

  // Answers a pending request by key; resolves ok or with the calm failure
  // message. Never throws.
  const respondApproval = useCallback(
    async (key: string, decision: "allow" | "deny"): Promise<RespondResult> => {
      const current = clientRef.current;
      const request = current?.pendingApprovals.find((entry) => entry.key === key);
      if (!current || !request) {
        return { ok: false, message: "request is not pending (already answered?)" };
      }
      return current.respond(request.server, request.id, decision);
    },
    [],
  );

  const value = useMemo<RelayContextValue>(
    () => ({
      hydrated,
      credentials,
      client,
      status,
      authFailed,
      servers,
      lastError,
      demo,
      retryAt,
      reconnectAttempts,
      relayProtocol,
      relayFeatures,
      pendingApprovals,
      connectedUrl,
      connect,
      startDemo,
      exitDemo,
      unpair,
      retryNow,
      rpc,
      respondApproval,
    }),
    [
      hydrated,
      credentials,
      client,
      status,
      authFailed,
      servers,
      lastError,
      demo,
      retryAt,
      reconnectAttempts,
      relayProtocol,
      relayFeatures,
      pendingApprovals,
      connectedUrl,
      connect,
      startDemo,
      exitDemo,
      unpair,
      retryNow,
      rpc,
      respondApproval,
    ],
  );

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
}

export function useRelay(): RelayContextValue {
  const value = useContext(RelayContext);
  if (!value) throw new Error("useRelay must be used inside <RelayProvider>");
  return value;
}

// Reduces this session's event stream into chat state. Other sessions'
// events are filtered out inside the reducer.
export function useSessionEvents(sessionId: string): SessionState {
  const { client } = useRelay();
  const [state, setState] = useState<SessionState>(() => initialSessionState(sessionId));

  useEffect(() => {
    setState(initialSessionState(sessionId));
    if (!client) return;
    let current = initialSessionState(sessionId);
    const off = client.onEvent((msg: RelayMessage) => {
      current = reduce(current, msg);
      setState(current);
    });
    return off;
  }, [client, sessionId]);

  return state;
}
