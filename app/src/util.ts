export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function numValue(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Response shapes from the app server are not documented; pull the first
// array we can find, else nothing.
export function pickArray(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const obj = result as Record<string, any> | null;
  if (!obj || typeof obj !== "object") return [];
  for (const key of ["sessions", "items", "messages", "data", "result"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as any).sessions)) {
      return (value as any).sessions;
    }
  }
  return [];
}

export interface SessionRow {
  id: string;
  title: string;
  folder: string;
  status: string;
  updatedAt: number | null;
}

export function parseSessionList(result: unknown): SessionRow[] {
  try {
    return pickArray(result)
      .map((raw: any): SessionRow => {
        const cwd = str(
          raw?.workspace?.workspacePath ??
            raw?.workspacePath ??
            raw?.cwd ??
            raw?.workspace ??
            raw?.directory ??
            raw?.folder,
        );
        return {
          id: str(raw?.sessionId ?? raw?.id),
          title: str(raw?.title ?? raw?.name) || "Untitled session",
          folder: cwd ? basename(cwd) : "",
          status: str(raw?.status ?? raw?.state) || "idle",
          updatedAt: numValue(
            raw?.updatedAt ??
              raw?.updated_at ??
              raw?.lastActivityAt ??
              raw?.timestamp ??
              raw?.createdAt ??
              raw?.created_at,
          ),
        };
      })
      .filter((row) => row.id);
  } catch {
    return [];
  }
}
