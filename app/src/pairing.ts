export interface PairingPayload {
  u: string; // relay URL, ws:// or wss:// (http(s) accepted)
  w: string; // workspace shown in the QR
  c: string; // one-time pair code
}

export interface PairResult {
  id: string;
  token: string;
  wsUrl: string;
}

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
    const u = typeof data?.u === "string" ? data.u.trim() : "";
    const w = typeof data?.w === "string" ? data.w.trim() : "";
    const c = typeof data?.c === "string" ? data.c.trim() : "";
    if (!u || !w || !c) {
      sawIncomplete = true;
      continue;
    }
    if (!/^(ws|wss|http|https):\/\//i.test(u)) {
      sawBadUrl = true;
      continue;
    }
    return { u, w, c };
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

// POST {u}/pair with {code, name} -> {id, token}. The token is only returned
// here; callers store it and never log it.
export async function pair(
  payload: PairingPayload,
  deviceName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(`${toHttpBase(payload.u)}/pair`, {
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
    return { id, token, wsUrl: toWsUrl(payload.u) };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Pairing timed out. Check that this phone can reach the Mac.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
