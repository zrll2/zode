import { describeAttachment } from "./attachments";
import type { ChatItem, ChatItemAttachment } from "./relay/reducer";

// Verified session/messages shape: result.messages[], each
// {info:{id, role, time}, parts:[{type:"text"|"reasoning"|"tool"|...}]}.
// step-start / step-finish / timeline parts carry no chat content and are
// skipped. Anything unexpected yields an empty list, never a crash.

const TOOL_OUTPUT_LIMIT = 600;

export function messagesToItems(result: unknown): ChatItem[] {
  const messages = extractMessages(result);
  const items: ChatItem[] = [];
  messages.forEach((message: any, messageIdx: number) => {
    // The desktop hides messages marked uiVisibility:"hidden" (todo
    // reminders, background notifications); drop them entirely.
    if (message?.info?.semantics?.uiVisibility === "hidden") return;
    const role = typeof message?.info?.role === "string" ? message.info.role : "";
    const id = typeof message?.info?.id === "string" ? message.info.id : `m${messageIdx}`;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    // user file parts become chips on the user items (no separate rows)
    const userFiles: ChatItemAttachment[] =
      role === "user"
        ? parts
            .filter((part: any) => part?.type === "file")
            .map((part: any) => describeAttachment(part))
        : [];
    parts.forEach((part: any, partIdx: number) => {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type === "text") {
        const text = typeof part.text === "string" ? part.text : "";
        if (!text.trim()) return;
        if (role === "user") {
          items.push({
            key: `h-${id}-${partIdx}`,
            kind: "user",
            text,
            attachments: userFiles.length > 0 ? userFiles : undefined,
          } as ChatItem);
        } else {
          items.push({ key: `h-${id}-${partIdx}`, kind: "assistant", text });
        }
      } else if (type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "";
        if (!text.trim()) return;
        items.push({ key: `h-${id}-${partIdx}`, kind: "reasoning", text });
      } else if (type === "tool") {
        const rawInput = typeof part?.state?.input === "string" ? part.state.input : "";
        const rawOutput = typeof part?.state?.output === "string" ? part.state.output : "";
        items.push({
          key: `h-${id}-${partIdx}`,
          kind: "tool",
          text: "",
          toolName: typeof part?.tool === "string" ? part.tool : undefined,
          toolCallId: typeof part?.callID === "string" ? part.callID : undefined,
          toolState: typeof part?.state?.status === "string" ? part.state.status : undefined,
          toolInput: clampText(rawInput, 2000),
          toolOutput: clampText(rawOutput, TOOL_OUTPUT_LIMIT),
        } as ChatItem);
      }
    });
  });
  return items;
}

function extractMessages(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const obj = result as Record<string, any> | null;
  if (obj && typeof obj === "object" && Array.isArray(obj.messages)) return obj.messages;
  return [];
}

function clampText(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

// Harness-injected user messages render as a collapsed system row instead of
// a bubble (DESIGN.md §3.2). Case-sensitive prefixes, after trimming.
const SYSTEM_PREFIXES = [
  "<task-notification",
  "<system-reminder",
  "<command-name>",
  "Available agent types for the Agent tool",
  "The TodoWrite tool hasn't been used recently",
];

export function isSystemLikeUserText(text: string): boolean {
  const trimmed = text.trim();
  return SYSTEM_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
// History renders above live events. A replayed live turn starts with the
// user input, so drop the history tail from the last matching input on
// instead of duplicating the turn.
export function mergeHistoryWithLive(history: ChatItem[], live: ChatItem[]): ChatItem[] {
  if (history.length === 0) return live;
  if (live.length === 0) return history;
  const firstLiveUser = live.find((item) => item.kind === "user");
  if (!firstLiveUser) return [...history, ...live];
  let duplicateAt = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    // live user text is trimmed by the reducer; history text may not be
    if (history[i].kind === "user" && history[i].text.trim() === firstLiveUser.text.trim()) {
      duplicateAt = i;
      break;
    }
  }
  if (duplicateAt === -1) return [...history, ...live];
  return [...history.slice(0, duplicateAt), ...live];
}
