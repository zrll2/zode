export interface PairingPayload {
  u: string; // first relay URL, ws:// or wss:// (http(s) accepted)
  urls: string[]; // every relay address, u first (normalised, deduped, cap 6)
  w: string; // workspace shown in the QR
  c: string; // one-time pair code
}

export interface PairResult {
  id: string;
  token: string;
  wsUrl: string;
  wsUrls: string[]; // every address the pairing offered, ws normalised
}

const URL_RE = /^(ws|wss|http|https):\/\//i;
const URLS_CAP = 6;
const PAIR_ATTEMPT_TIMEOUT_MS = 4_000;

// iOS smart punctuation and stray invisible spaces: straighten quotes and
// drop zero-width / non-breaking spaces before parsing.
function normalizePasted(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, "")
    .trim();
}

// The field may hold leftover text around the fresh paste; pull out every
// top-level {...} object (string-aware so braces inside values don't count).
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

// One relay url: trimmed, must start with ws/wss/http/https; else "".
export function cleanRelayUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return URL_RE.test(trimmed) ? trimmed : "";
}

// A list of relay urls: cleaned, deduped, order kept, junk dropped.
export function sanitizeUrlList(values: unknown): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of Array.isArray(values) ? values : []) {
    const url = cleanRelayUrl(entry);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

// u first, then urls: normalised, deduped, capped. Returns null when
// neither u nor any entry is usable.
function gatherUrls(u: unknown, rawUrls: unknown): string[] | null {
  const urls = [u, ...(Array.isArray(rawUrls) ? rawUrls : [])].reduce<string[]>(
    (list, entry) => {
      const url = cleanRelayUrl(entry);
      if (url && !list.includes(url) && list.length < URLS_CAP) list.push(url);
      return list;
    },
    [],
  );
  return urls.length ? urls : null;
}

export function parsePairingPayload(text: string): PairingPayload {
  const normalized = normalizePasted(text);
  const candidates = extractJsonObjects(normalized);

  // Try candidates last to first: leftover text sits before the fresh paste.
  let sawIncomplete = false;
  let sawBadUrl = false;
  for (let i = candidates.length - 1; i >= 0; i--) {
    let data: any;
    try {
      data = JSON.parse(candidates[i]);
    } catch {
      continue;
    }
    const w = typeof data?.w === "string" ? data.w.trim() : "";
    const c = typeof data?.c === "string" ? data.c.trim() : "";
    if (!w || !c) {
      sawIncomplete = true;
      continue;
    }
    const urls = gatherUrls(data?.u, data?.urls);
    if (!urls) {
      sawBadUrl = true;
      continue;
    }
    return { u: urls[0] ?? "", urls, w, c };
  }

  if (candidates.length && (sawIncomplete || sawBadUrl)) {
    if (sawIncomplete) throw new Error("Pairing text is missing u, w or c.");
    throw new Error("The relay URL must start with ws:// or wss://.");
  }
  throw new Error(
    "That is not valid JSON. Paste the pairing text shown by `./zode pair`.",
  );
}

function toHttpBase(url: string): string {
  return url.replace(/^ws/i, "http").replace(/\/+$/, "");
}

function toWsUrl(url: string): string {
  return url.replace(/^http/i, "ws").replace(/\/+$/, "");
}

// POST {url}/pair with {code, name} -> {id, token}. The token is only
// returned here; callers store it and never log it.
async function pairOnce(
  url: string,
  payload: PairingPayload,
  deviceName: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; token: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${toHttpBase(url)}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.c, name: deviceName }),
      signal: controller.signal,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      throw new Error(
        (typeof data?.error === "string" && data.error) ||
          `Pairing failed (HTTP ${res.status}). Is the relay running, and is the code still valid?`,
      );
    }
    const id = typeof data?.id === "string" ? data.id : "";
    const token = typeof data?.token === "string" ? data.token : "";
    if (!id || !token) throw new Error("The relay returned an unexpected pairing response.");
    return { id, token };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Pairing timed out. Check that this phone can reach the Mac.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Tries each offered address in turn (4 s per attempt, first success wins)
// so pairing works over Wi-Fi or Tailscale, whichever is reachable.
export async function pair(
  payload: PairingPayload,
  deviceName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairResult> {
  const candidates = payload.urls.length ? payload.urls : [payload.u];
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const { id, token } = await pairOnce(url, payload, deviceName, fetchImpl);
      const seen = new Set<string>();
      const wsUrls: string[] = [];
      for (const entry of candidates) {
        const ws = toWsUrl(entry);
        if (seen.has(ws)) continue;
        seen.add(ws);
        wsUrls.push(ws);
      }
      return { id, token, wsUrl: toWsUrl(url), wsUrls };
    } catch (e: unknown) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("Pairing failed.");
}

// Plain words for the diagnostics line: which network is this connection on?
// Tailscale addresses live in 100.64.0.0/10, home Wi-Fi in private ranges.
export function describeAddress(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url ?? "");
  const host = (match?.[1] ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!host) return "Connected";
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return "Connected over Tailscale";
  }
  if (
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  ) {
    return "Connected over Wi-Fi";
  }
  return "Connected";
}
