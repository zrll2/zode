// Pure model for the redesigned home list (docs/design/home-list-v2.html):
// project chips, live filtering, and the needs / running / history grouping
// with display-ready fields. Reuses sessionGroups' rules instead of
// duplicating them. No React and no network.
import { buildHomeSections } from "./sessionGroups";
import { projectName } from "./sessionStatus";
import type { SessionRow } from "./util";

export type HomeItemKind = "waiting" | "failed" | "running" | "history";

export interface HomeItem {
  id: string;
  title: string; // display title; falls back to the project name
  project: string;
  time: string; // shortAge label, e.g. "9 min", "Yesterday", "Oct 19"
  kind: HomeItemKind;
  status: string;
  updatedAt: number | null;
  // Pending permission requests waiting on this session (Needs you cards).
  askCount: number;
}

export interface HomeList {
  needs: HomeItem[];
  running: HomeItem[];
  today: HomeItem[];
  yesterday: HomeItem[];
  older: HomeItem[];
  hiddenWorkOrders: number;
  hiddenArchived: number;
}

export interface HomeListOptions {
  now: number;
  project?: string; // chip value, "All" or a project name
  query?: string; // live search text
  showWorkOrders: boolean;
  showArchived: boolean;
  archivedIds: string[];
  // Pending permission-request counts per session id.
  pendingBySession?: Record<string, number>;
}

// "#rrggbb" plus alpha → "rgba(...)", so tinted surfaces (the Needs you
// cards, the offline banner) come from theme tokens without new hard-coded
// colors. Non-hex input passes through unchanged.
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return hex;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Short age label for a timestamp: "now", "9 min", "1 h" (today),
// "Yesterday" (the calendar day before), then "Oct 19".
export function shortAge(updatedAt: number | null | undefined, now: number): string {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return "";
  const diff = now - updatedAt;
  if (diff < 60_000) return "now";
  const date = new Date(updatedAt);
  const todayStart = startOfDay(now);
  if (updatedAt >= todayStart) {
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h`;
  }
  if (updatedAt >= todayStart - 86_400_000) return "Yesterday";
  return `${MONTHS[date.getMonth()] ?? ""} ${date.getDate()}`.trim();
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// One chip per project (the last path segment of folder), sorted, "All"
// first. Sessions without a workspace get no chip.
export function projectsOf(sessions: SessionRow[]): string[] {
  const set = new Set<string>();
  for (const session of sessions) {
    if (!session.folder) continue;
    set.add(projectName(session.folder));
  }
  return ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
}

// Filter by project chip and/or live query; the query matches title and
// project, case-insensitively.
export function filterSessions(
  sessions: SessionRow[],
  options: { project?: string; query?: string },
): SessionRow[] {
  const project =
    options.project && options.project !== "All" ? options.project.toLowerCase() : null;
  const query = options.query?.trim().toLowerCase() ?? "";
  if (!project && !query) return sessions;
  return sessions.filter((session) => {
    const name = projectName(session.folder);
    if (project && name.toLowerCase() !== project) return false;
    if (query && !`${session.title} ${name}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function toItem(
  row: SessionRow,
  now: number,
  kind: HomeItemKind,
  askCount: number,
): HomeItem {
  const project = projectName(row.folder);
  return {
    id: row.id,
    title: row.title.trim() || project,
    project,
    time: shortAge(row.updatedAt, now),
    kind,
    status: row.status,
    updatedAt: row.updatedAt,
    askCount,
  };
}

// The home list model: attention first (Needs you = waiting or error), then
// Running, then Today / Yesterday, and everything older — including shown
// work orders and archived conversations — folded into `older`. The hidden
// counts feed the "N hidden · Show" footers.
export function buildHomeList(sessions: SessionRow[], options: HomeListOptions): HomeList {
  const { now } = options;
  const filtered = filterSessions(sessions, {
    project: options.project,
    query: options.query,
  });
  const built = buildHomeSections(filtered, now, {
    showWorkOrders: options.showWorkOrders,
    showArchived: options.showArchived,
    archivedIds: options.archivedIds,
  });
  const section = (key: string) => built.sections.find((part) => part.key === key)?.items ?? [];
  const askCount = (row: SessionRow) => options.pendingBySession?.[row.id] ?? 0;
  const map = (rows: SessionRow[], kind: HomeItemKind) =>
    rows.map((row) => toItem(row, now, kind, askCount(row)));
  const needsOf = (rows: SessionRow[]) =>
    rows.map((row) =>
      toItem(row, now, row.status === "error" ? "failed" : "waiting", askCount(row)),
    );

  return {
    needs: needsOf(section("needs-you")),
    running: map(section("running"), "running"),
    today: map(section("today"), "history"),
    yesterday: map(section("yesterday"), "history"),
    older: map(
      [
        ...section("previous-7-days"),
        ...section("earlier"),
        ...section("work-orders"),
        ...section("archived"),
      ],
      "history",
    ),
    hiddenWorkOrders: built.hiddenWorkOrders,
    hiddenArchived: built.hiddenArchived,
  };
}
