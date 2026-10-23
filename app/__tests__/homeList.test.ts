import { buildHomeList, filterSessions, projectsOf, shortAge } from "../src/homeList";
import { archiveKey } from "../src/sessionStatus";
import type { SessionRow } from "../src/util";

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-19 is a Monday; 15:00 local.
const NOW = new Date("2026-10-19T15:00:00").getTime();
const TODAY_START = new Date("2026-10-19T00:00:00").getTime();

function row(
  id: string,
  title: string,
  folder: string,
  status: string,
  updatedAt: number | null,
): SessionRow {
  return { id, title, folder, status, updatedAt };
}

const BASE = {
  now: NOW,
  showWorkOrders: false,
  showArchived: false,
  archivedIds: [],
};

describe("projectsOf", () => {
  it("lists All plus one sorted chip per project, deduped", () => {
    const sessions = [
      row("a", "A", "/Users/demo/projects/web-app", "idle", NOW),
      row("b", "B", "shop-api", "idle", NOW),
      row("c", "C", "/Users/demo/projects/web-app", "idle", NOW),
    ];
    expect(projectsOf(sessions)).toEqual(["All", "shop-api", "web-app"]);
  });

  it("skips sessions without a workspace", () => {
    expect(projectsOf([row("a", "A", "", "idle", NOW)])).toEqual(["All"]);
    expect(projectsOf([])).toEqual(["All"]);
  });
});

describe("filterSessions", () => {
  const sessions = [
    row("a", "Fix flaky checkout test", "shop-api", "idle", NOW),
    row("b", "Add dark mode toggle", "web-app", "idle", NOW),
    row("c", "shop-api migration", "docs-site", "idle", NOW),
  ];

  it("returns the same list without options", () => {
    expect(filterSessions(sessions, {})).toBe(sessions);
    expect(filterSessions(sessions, { project: "All" })).toBe(sessions);
  });

  it("filters by project, case-insensitively", () => {
    expect(filterSessions(sessions, { project: "web-app" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterSessions(sessions, { project: "SHOP-API" }).map((s) => s.id)).toEqual(["a"]);
  });

  it("matches the query against title and project, case-insensitively", () => {
    expect(filterSessions(sessions, { query: "flaky" }).map((s) => s.id)).toEqual(["a"]);
    expect(filterSessions(sessions, { query: "WEB-APP" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterSessions(sessions, { query: "  DARK " }).map((s) => s.id)).toEqual(["b"]);
    expect(filterSessions(sessions, { query: "zzz" })).toEqual([]);
  });

  it("combines project and query", () => {
    expect(
      filterSessions(sessions, { project: "shop-api", query: "flaky" }).map((s) => s.id),
    ).toEqual(["a"]);
    expect(
      filterSessions(sessions, { project: "docs-site", query: "flaky" }),
    ).toEqual([]);
  });
});

describe("buildHomeList: grouping", () => {
  const sessions = [
    row("w", "Needs an answer", "shop-api", "waiting", NOW),
    row("e", "Broken build", "web-app", "error", NOW),
    row("r", "Long task", "docs-site", "running", NOW),
    row("t", "Today work", "shop-api", "idle", NOW),
    row("y", "Yesterday work", "web-app", "idle", TODAY_START - 1),
    row("w7", "This week", "shop-api", "idle", TODAY_START - 3 * DAY),
    row("old", "Old work", "docs-site", "idle", TODAY_START - 9 * DAY),
  ];

  it("splits the list into needs, running, today, yesterday and older", () => {
    const list = buildHomeList(sessions, BASE);
    expect(list.needs.map((item) => item.id)).toEqual(["w", "e"]);
    expect(list.running.map((item) => item.id)).toEqual(["r"]);
    expect(list.today.map((item) => item.id)).toEqual(["t"]);
    expect(list.yesterday.map((item) => item.id)).toEqual(["y"]);
    expect(list.older.map((item) => item.id)).toEqual(["w7", "old"]);
    expect(list.hiddenWorkOrders).toBe(0);
    expect(list.hiddenArchived).toBe(0);
  });

  it("carries display fields: title, project, time and kind", () => {
    const list = buildHomeList(sessions, BASE);
    expect(list.needs[0]).toMatchObject({
      id: "w",
      title: "Needs an answer",
      project: "shop-api",
      time: "now",
      kind: "waiting",
    });
    expect(list.needs[1]?.kind).toBe("failed");
    expect(list.running[0]).toMatchObject({ kind: "running", time: "now" });
    expect(list.older[1]?.kind).toBe("history");
  });

  it("sorts history newest first and counts pending asks per session", () => {
    const withAsks = [
      row("t2", "Newer today", "shop-api", "idle", NOW),
      row("t1", "Older today", "shop-api", "idle", NOW - 60_000),
      row("w", "Needs an answer", "shop-api", "waiting", NOW),
    ];
    const list = buildHomeList(withAsks, {
      ...BASE,
      pendingBySession: { w: 2, t1: 1 },
    });
    expect(list.today.map((item) => item.id)).toEqual(["t2", "t1"]);
    expect(list.today.map((item) => item.askCount)).toEqual([0, 1]);
    expect(list.needs[0]?.askCount).toBe(2);
  });

  it("returns empty buckets for empty input", () => {
    const list = buildHomeList([], BASE);
    expect(list).toEqual({
      needs: [],
      running: [],
      today: [],
      yesterday: [],
      older: [],
      hiddenWorkOrders: 0,
      hiddenArchived: 0,
    });
  });
});

describe("buildHomeList: titles", () => {
  it("falls back to the project name for empty or whitespace titles", () => {
    const list = buildHomeList(
      [
        row("a", "", "shop-api", "idle", NOW),
        row("b", "   ", "/x/y/web-app", "idle", NOW),
      ],
      BASE,
    );
    expect(list.today.map((item) => item.title)).toEqual(["shop-api", "web-app"]);
  });
});

describe("buildHomeList: work orders and archive", () => {
  const sessions = [
    row("wo", "# tidy the imports", "shop-api", "idle", NOW),
    row("plain", "Fix a bug", "web-app", "idle", NOW),
    row("gone", "Archived chat", "shop-api", "idle", NOW),
  ];

  it("hides finished work orders and archived chats, counting both", () => {
    const list = buildHomeList(sessions, {
      ...BASE,
      archivedIds: [archiveKey("gone")],
    });
    expect(list.today.map((item) => item.id)).toEqual(["plain"]);
    expect(list.hiddenWorkOrders).toBe(1);
    expect(list.hiddenArchived).toBe(1);
  });

  it("folds shown work orders and archived chats into older", () => {
    const list = buildHomeList(sessions, {
      ...BASE,
      showWorkOrders: true,
      showArchived: true,
      archivedIds: [archiveKey("gone")],
    });
    expect(list.older.map((item) => item.id).sort()).toEqual(["gone", "wo"]);
    expect(list.hiddenWorkOrders).toBe(0);
    expect(list.hiddenArchived).toBe(0);
  });

  it("applies project and query filters before grouping", () => {
    const list = buildHomeList(sessions, {
      ...BASE,
      project: "shop-api",
      showWorkOrders: true,
      archivedIds: [archiveKey("gone")],
    });
    expect(list.today).toEqual([]);
    expect(list.older.map((item) => item.id)).toEqual(["wo"]);
    expect(list.hiddenArchived).toBe(1);
  });
});

describe("shortAge", () => {
  it("labels very recent edits as now", () => {
    expect(shortAge(NOW - 30_000, NOW)).toBe("now");
    expect(shortAge(NOW, NOW)).toBe("now");
  });

  it("uses minutes and hours within today", () => {
    expect(shortAge(NOW - 9 * 60_000, NOW)).toBe("9 min");
    expect(shortAge(NOW - 59 * 60_000, NOW)).toBe("59 min");
    expect(shortAge(NOW - 2 * 3_600_000, NOW)).toBe("2 h");
  });

  it("says Yesterday for the calendar day before, not any 24 h span", () => {
    expect(shortAge(TODAY_START - 1, NOW)).toBe("Yesterday");
    expect(shortAge(TODAY_START - DAY, NOW)).toBe("Yesterday");
  });

  it("formats older dates as short month and day", () => {
    expect(shortAge(TODAY_START - DAY - 1, NOW)).toBe("Oct 17");   // just before the start of yesterday
    expect(shortAge(new Date("2026-09-30T12:00:00").getTime(), NOW)).toBe("Sep 30");
  });

  it("returns nothing without a timestamp", () => {
    expect(shortAge(null, NOW)).toBe("");
    expect(shortAge(undefined, NOW)).toBe("");
  });
});
