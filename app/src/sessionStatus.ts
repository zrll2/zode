// Plain-words status mapping and home-card helpers (order 16).
export type StatusLightColor = "ok" | "warn" | "danger" | "accent";

export interface StatusInfo {
  light: StatusLightColor;
  word: string;
}

export function statusInfo(status: string): StatusInfo {
  switch (status) {
    case "waiting":
      return { light: "warn", word: "Waiting for you" };
    case "error":
      return { light: "danger", word: "Failed" };
    case "running":
      return { light: "accent", word: "Working" };
    case "idle":
      return { light: "ok", word: "Completed" };
    default:
      return { light: "ok", word: "Stopped" };
  }
}

// Work orders are conversations whose title starts with "#".
export function isWorkOrder(title: string): boolean {
  return title.trim().startsWith("#");
}

// Re-exported so callers have one import for the session helpers; defined
// in src/sessionActions.ts.
export { archiveKey } from "./sessionActions";

// Card title: the last path segment of the workspace folder.
export function projectName(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "No workspace";
}
