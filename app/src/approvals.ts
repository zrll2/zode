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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Risky-command classification, a copy of relay/risk.mjs — keep the two in
// step. Matching runs on a normalised shape, never the raw text: lowercase,
// collapsed whitespace, split on the shell separators ; && || |, and the
// wrapper words env/command/nohup/time stripped from the front. That is what
// makes `rm -fr`, `rm -r -f`, `env sudo` and `sudo` after a separator count,
// while look-alikes ("pseudocode", "curl-config", "wget2", "add") still do not.
const WRAPPERS = new Set(["env", "command", "nohup", "time"]);

const flagLetters = (token: string): string => token.replace(/-/g, "");

// -> ["sudo ls", ...]: lowercase, whitespace collapsed, split on ; && || |,
// wrappers stripped.
export function commandSegments(command: string): string[] {
  return command
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/ *(?:&&|\|\||[;|]) */)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const words = segment.split(" ");
      while (words.length && WRAPPERS.has(words[0])) words.shift();
      return words.join(" ");
    })
    .filter(Boolean);
}

// The classics: destructive whatever the agent thinks the risk is. Checked
// per segment.
function alwaysRisky(segment: string): boolean {
  const w = segment.split(" ");
  return w.some((token, i) => {
    if (token === "sudo") return true;
    if (token === "rm") {
      // both r and f, any order, combined or separate (-fr, -r -f, -Rf,
      // --recursive --force)
      let r = false;
      let f = false;
      for (let j = i + 1; j < w.length; j++) {
        if (!w[j].startsWith("-")) continue;
        if (flagLetters(w[j]).includes("r")) r = true;
        if (flagLetters(w[j]).includes("f")) f = true;
      }
      return r && f;
    }
    if (token === "git" && w[i + 1] === "push") {
      // -f, --force, --force-with-lease
      for (let j = i + 2; j < w.length; j++) {
        if (!w[j].startsWith("-")) continue;
        const body = w[j].replace(/^-+/, "");
        if (body.includes("force")) return true;
        if (!w[j].startsWith("--") && body.includes("f")) return true;
      }
      return false;
    }
    if (token === "git" && w[i + 1] === "reset" && w.includes("--hard")) return true;
    if (
      (token === "chmod" || token === "chown") &&
      w.slice(i + 1).some((t) => /^-{1,2}r/.test(t))
    ) {
      return true;
    }
    if (/^mkfs(\.|$)/.test(token)) return true;
    if (token === "dd" && w.slice(i + 1).some((t) => t.startsWith("of="))) return true;
    return false;
  });
}

// Destructive enough that the agent's own high flag must make a human look.
function highRisky(segment: string): boolean {
  const w = segment.split(" ");
  if (w[0] === "git" && w[1] === "push") return true;
  if (w[0] === "npm" && w[1] === "publish") return true;
  if (
    w[0] === "curl" ||
    w[0] === "wget" ||
    w[0] === "chmod" ||
    w[0] === "chown" ||
    w[0] === "dd"
  ) {
    return true;
  }
  return />>?\s*\/dev\//.test(segment);
}

// Risky when the command is on the destructive list whatever the agent
// thinks, or the agent flagged it high AND the command needs a human look.
export function isRisky(params: Record<string, unknown>): boolean {
  const input = isRecord(params.input) ? params.input : {};
  const command = str(input.command);
  if (!command.trim()) return false;
  const segments = commandSegments(command);
  if (segments.some(alwaysRisky)) return true;
  return params.riskLevel === "high" && segments.some(highRisky);
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
