import { isArchived } from "./sessionActions";
import { isWorkOrder } from "./sessionStatus";
import type { SessionRow } from "./util";

export interface SessionSection {
  key: string;
  title: string;
  items: SessionRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Sessions grouped for the home list: attention first (Needs you = waiting or
// error, then Running), then recency buckets Today / Yesterday /
// Previous 7 days / Earlier. Empty sections are dropped; sessions without a
// timestamp land in Earlier. Buckets sort by recency, newest first.
export function groupSessions(sessions: SessionRow[], now: number): SessionSection[] {
  const todayStart = startOfToday(now);
  const needsYou: SessionRow[] = [];
  const running: SessionRow[] = [];
  const today: SessionRow[] = [];
  const yesterday: SessionRow[] = [];
  const previous7: SessionRow[] = [];
  const earlier: SessionRow[] = [];

  for (const session of sessions) {
    if (session.status === "waiting" || session.status === "error") {
      needsYou.push(session);
      continue;
    }
    if (session.status === "running") {
      running.push(session);
      continue;
    }
    const ts = session.updatedAt;
    if (ts !== null && ts >= todayStart) today.push(session);
    else if (ts !== null && ts >= todayStart - DAY_MS) yesterday.push(session);
    else if (ts !== null && ts >= todayStart - 7 * DAY_MS) previous7.push(session);
    else earlier.push(session);
  }

  const byRecency = (a: SessionRow, b: SessionRow) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  for (const bucket of [needsYou, running, today, yesterday, previous7, earlier]) {
    bucket.sort(byRecency);
  }

  const allSections: SessionSection[] = [
    { key: "needs-you", title: "Needs you", items: needsYou },
    { key: "running", title: "Running", items: running },
    { key: "today", title: "Today", items: today },
    { key: "yesterday", title: "Yesterday", items: yesterday },
    { key: "previous-7-days", title: "Previous 7 days", items: previous7 },
    { key: "earlier", title: "Earlier", items: earlier },
  ];
  return allSections.filter((section) => section.items.length > 0);
}

export interface HomePrefs {
  showWorkOrders: boolean;
  showArchived: boolean;
  archivedIds: string[];
}

// Home screen sections (order 16/17b): Needs you and Running first — urgent
// sessions, including archived ones, never hide — then the recency buckets,
// then finished work orders and archived conversations, which are hidden
// (and counted) unless their setting is on. An archived work order counts as
// archived only. Empty sections are dropped.
export function buildHomeSections(
  sessions: SessionRow[],
  now: number,
  prefs: HomePrefs,
): { sections: SessionSection[]; hiddenWorkOrders: number; hiddenArchived: number } {
  const needsYou: SessionRow[] = [];
  const running: SessionRow[] = [];
  const rest: SessionRow[] = [];
  const workOrders: SessionRow[] = [];
  const archived: SessionRow[] = [];
  let hiddenWorkOrders = 0;
  let hiddenArchived = 0;

  for (const session of sessions) {
    if (session.status === "waiting" || session.status === "error") {
      needsYou.push(session);
      continue;
    }
    if (session.status === "running") {
      running.push(session);
      continue;
    }
    if (isArchived(prefs.archivedIds, session.id)) {
      if (prefs.showArchived) archived.push(session);
      else hiddenArchived += 1;
      continue;
    }
    if (isWorkOrder(session.title)) {
      if (prefs.showWorkOrders) workOrders.push(session);
      else hiddenWorkOrders += 1;
      continue;
    }
    rest.push(session);
  }

  const byRecency = (a: SessionRow, b: SessionRow) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  needsYou.sort(byRecency);
  running.sort(byRecency);
  workOrders.sort(byRecency);
  archived.sort(byRecency);

  const sections: SessionSection[] = [];
  const push = (key: string, title: string, items: SessionRow[]) => {
    if (items.length > 0) sections.push({ key, title, items });
  };
  push("needs-you", "Needs you", needsYou);
  push("running", "Running", running);
  sections.push(...groupSessions(rest, now));
  push("work-orders", "Work orders", workOrders);
  push("archived", "Archived", archived);

  return { sections, hiddenWorkOrders, hiddenArchived };
}
