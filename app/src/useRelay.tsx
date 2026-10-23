import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { friendlyError } from "./friendlyError";
import * as Linking from "expo-linking";
import { RelayClient, type RelayStatus } from "./relay/client";
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
  connect(credentials: Credentials): void;
  startDemo(): void;
  exitDemo(): Promise<void>;
  unpair(): Promise<void>;
  retryNow(): void;
  rpc<T = unknown>(method: string, params?: unknown, server?: string | number): Promise<T>;
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
  const clientRef = useRef<RelayClientLike | null>(null);

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
    const next = new RelayClient({ url: creds.wsUrl, token: creds.token });
    clientRef.current = next;
    next.onStatus((s) => {
      setStatus(s);
      setServers([...next.servers]);
      setRelayProtocol(next.relayProtocol);
    });
    setAuthFailed(false);
    setLastError(null);
    setDemo(false);
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
    });
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
  }, []);

  const unpair = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    await clearCredentials();
    setCredentials(null);
    setDemo(false);
    setStatus("closed");
    setServers([]);
    setAuthFailed(false);
    setLastError(null);
    setRelayProtocol(undefined);
  }, []);

  const rpc = useCallback(
    <T,>(method: string, params?: unknown, server?: string | number): Promise<T> => {
      const current = clientRef.current;
      if (!current) return Promise.reject(new Error("Not paired yet."));
      return current.rpc<T>(method, params, server);
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
      connect,
      startDemo,
      exitDemo,
      unpair,
      retryNow,
      rpc,
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
      connect,
      startDemo,
      exitDemo,
      unpair,
      retryNow,
      rpc,
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
