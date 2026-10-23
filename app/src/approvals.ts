// Pure helpers for Ask-first permission requests: parse the relay's pending
// list and approval events, summarize them for cards, detect risky commands,
// and word the calm failure lines. No React and no network.

export type ApprovalDecision = "allow" | "deny";
export type ApprovalKind = "permission" | "question";

export interface ApprovalRequest {
  key: string; // `${server}:${id}` — the pair the relay resolves answers by
  server: string;
  id: string;
  kind: ApprovalKind;
  sessionId: string;
  toolName: string;
  summary: string; // one short card line, at most 80 characters
  detail: string; // full command or path, never truncated
  risky: boolean;
  at: number;
}

const SUMMARY_MAX = 80;

const RISKY_SUBSTRINGS = ["rm -rf", "git push", "npm publish", "> /dev/"];
// Word boundaries keep look-alikes ("pseudocode", "add file", "curl-config",
// "wget2") from matching; mkfs matches as a whole word so mkfs.ext4 counts.
const RISKY_WORDS = /\b(?:sudo|chmod|chown|dd|curl|wget)\s|\bmkfs\b/;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Risky only when the relay already flagged the request high AND the command
// itself is on the destructive list.
export function isRisky(params: Record<string, unknown>): boolean {
  if (params.riskLevel !== "high") return false;
  const input = isRecord(params.input) ? params.input : {};
  const command = str(input.command);
  if (!command) return false;
  return RISKY_SUBSTRINGS.some((part) => command.includes(part)) || RISKY_WORDS.test(command);
}

function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

// One short card line ("Run: npm test" / "Edit: App.tsx") plus the
// untruncated detail for the sheet and the risky confirmation.
export function summarizeRequest(params: Record<string, unknown>): {
  summary: string;
  detail: string;
} {
  const input = isRecord(params.input) ? params.input : {};
  const command = str(input.command);
  const filePath = str(input.file_path);
  const description = str(input.description);
  if (command) return { summary: truncate(`Run: ${command}`), detail: command };
  if (filePath) return { summary: truncate(`Edit: ${fileName(filePath)}`), detail: filePath };
  if (description) return { summary: truncate(description), detail: description };
  const reason = str(params.reason);
  return { summary: truncate(reason || "Permission needed"), detail: reason };
}

function buildRequest(entry: {
  server: unknown;
  id: unknown;
  method: unknown;
  params: unknown;
  at: unknown;
}): ApprovalRequest | null {
  const id = str(entry.id);
  const method = str(entry.method);
  if (!id) return null;
  let kind: ApprovalKind;
  if (method === "interaction/requestPermission") kind = "permission";
  else if (method === "interaction/requestUserInput") kind = "question";
  else return null;
  const params = isRecord(entry.params) ? entry.params : {};
  const { summary, detail } = summarizeRequest(params);
  return {
    key: `${str(entry.server)}:${id}`,
    server: str(entry.server),
    id,
    kind,
    sessionId: str(params.sessionId),
    toolName: str(params.toolName) || (kind === "question" ? "Question" : "Request"),
    summary,
    detail,
    risky: kind === "permission" && isRisky(params),
    at: num(entry.at),
  };
}

// Accepts a ready frame (with its authoritative pending list), an event frame
// carrying one new request, or that frame's msg. Junk in, empty list out.
export function parsePending(input: unknown): ApprovalRequest[] {
  const frame = isRecord(input) ? input : {};
  if (frame.type === "ready") {
    const pending = Array.isArray(frame.pending) ? frame.pending : [];
    return pending
      .map((entry) =>
        isRecord(entry)
          ? buildRequest({
              server: entry.server,
              id: entry.id,
              method: entry.method,
              params: entry.params,
              at: entry.at,
            })
          : null,
      )
      .filter((request): request is ApprovalRequest => request !== null);
  }
  const msg = frame.type === "event" && isRecord(frame.msg) ? frame.msg : frame;
  const single = buildRequest({
    server: str(frame.server),
    id: msg.id,
    method: msg.method,
    params: msg.params,
    at: isRecord(msg.params) ? msg.params.at : undefined,
  });
  return single ? [single] : [];
}

export function applyResolved(
  list: ApprovalRequest[],
  server: string,
  id: string,
): ApprovalRequest[] {
  if (!id) return list;
  const key = `${server}:${id}`;
  return list.filter((request) => request.key !== key);
}

function sortOldestFirst(list: ApprovalRequest[]): ApprovalRequest[] {
  return list
    .map((request, index) => ({ request, index }))
    .sort((a, b) => a.request.at - b.request.at || a.index - b.index)
    .map((entry) => entry.request);
}

// Folds a relay frame into the pending list: a ready frame replaces it
// outright, a new request is added (deduped by key), tap/resolved removes
// one. Result is always ordered oldest first.
export function reduceApprovals(
  list: ApprovalRequest[],
  frame: unknown,
  now = 0,
): ApprovalRequest[] {
  const f = isRecord(frame) ? frame : null;
  if (!f) return list;
  if (f.type === "ready") return sortOldestFirst(parsePending(f));
  if (f.type !== "event") return list;
  const msg = isRecord(f.msg) ? f.msg : {};
  const method = str(msg.method);
  if (method === "tap/resolved") {
    const params = isRecord(msg.params) ? msg.params : {};
    return applyResolved(list, str(f.server), str(params.id));
  }
  if (method === "interaction/requestPermission" || method === "interaction/requestUserInput") {
    const incoming = parsePending(f)[0];
    if (!incoming) return list;
    const rest = list.filter((request) => request.key !== incoming.key);
    return sortOldestFirst([...rest, { ...incoming, at: incoming.at || now }]);
  }
  return list;
}

// Calm feedback for a failed answer: losing the answer race is normal, never
// an error screen.
export function respondFailureText(message: string | undefined): string {
  if (!message) return "Could not answer. Try again.";
  const text = message.toLowerCase();
  if (text.includes("not pending") || text.includes("already")) return "Already answered";
  return `${message.replace(/[.!?]+$/, "")}. Try again.`;
}
