import { buildHomeSections, groupSessions } from "../src/sessionGroups";
import { isWorkOrder, projectName, statusInfo } from "../src/sessionStatus";
import type { SessionRow } from "../src/util";

const NOW = new Date("2026-10-19T15:00:00").getTime();
const TODAY_START = new Date("2026-10-19T00:00:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function row(id: string, title: string, status: string, updatedAt: number | null): SessionRow {
  return { id, title, folder: "wt", status, updatedAt };
}

function sectionKeys(sections: { key: string }[]) {
  return sections.map((section) => section.key);
}

function itemsIn(sections: { key: string; items: SessionRow[] }[], key: string) {
  return sections.find((section) => section.key === key)?.items ?? [];
}

describe("isWorkOrder", () => {
  it("matches titles that start with # after trimming", () => {
    expect(isWorkOrder("# refactor the parser")).toBe(true);
    expect(isWorkOrder("   #refactor")).toBe(true);
    expect(isWorkOrder("refactor the parser")).toBe(false);
    expect(isWorkOrder("#")).toBe(true);
    expect(isWorkOrder("")).toBe(false);
  });
});

describe("projectName", () => {
  it("takes the last path segment", () => {
    expect(projectName("/a/b/c")).toBe("c");
    expect(projectName("/a/b/c/")).toBe("c");
    expect(projectName("shop-api")).toBe("shop-api");
  });

  it("falls back to No workspace when empty", () => {
    expect(projectName("")).toBe("No workspace");
    expect(projectName("/")).toBe("No workspace");
  });
});

describe("statusInfo", () => {
  it("maps every known status", () => {
    expect(statusInfo("waiting")).toEqual({ light: "warn", word: "Waiting for you" });
    expect(statusInfo("error")).toEqual({ light: "danger", word: "Failed" });
    expect(statusInfo("running")).toEqual({ light: "accent", word: "Working" });
    expect(statusInfo("idle")).toEqual({ light: "ok", word: "Completed" });
  });

  it("maps unknown statuses to Stopped", () => {
    expect(statusInfo("compacting")).toEqual({ light: "ok", word: "Stopped" });
    expect(statusInfo("")).toEqual({ light: "ok", word: "Stopped" });
  });
});

describe("buildHomeSections", () => {
  it("hides finished work orders and counts them while the setting is off", () => {
    const result = buildHomeSections(
      [row("wo", "# tidy the imports", "idle", NOW)],
      NOW,
      false,
    );
    expect(result.hiddenWorkOrders).toBe(1);
    expect(result.sections).toEqual([]);
  });

  it("shows the work orders section when the setting is on", () => {
    const result = buildHomeSections(
      [row("wo", "# tidy the imports", "idle", NOW)],
      NOW,
      true,
    );
    expect(result.hiddenWorkOrders).toBe(0);
    expect(sectionKeys(result.sections)).toEqual(["work-orders"]);
    expect(itemsIn(result.sections, "work-orders").map((s) => s.id)).toEqual(["wo"]);
  });

  it("keeps a waiting work order in Needs you", () => {
    const result = buildHomeSections([row("wo", "# fix hot path", "waiting", NOW)], NOW, false);
    expect(result.hiddenWorkOrders).toBe(0);
    expect(sectionKeys(result.sections)).toEqual(["needs-you"]);
    expect(itemsIn(result.sections, "needs-you").map((s) => s.id)).toEqual(["wo"]);
  });

  it("keeps a running work order in Running", () => {
    const result = buildHomeSections([row("wo", "# fix hot path", "running", NOW)], NOW, true);
    expect(result.hiddenWorkOrders).toBe(0);
    expect(sectionKeys(result.sections)).toEqual(["running"]);
  });

  it("groups the rest by recency and drops empty sections", () => {
    const result = buildHomeSections(
      [
        row("today", "Fix a bug", "idle", NOW),
        row("yesterday", "Fix another bug", "idle", TODAY_START - 1),
        row("old", "Old work", "idle", TODAY_START - 8 * DAY),
      ],
      NOW,
      false,
    );
    expect(sectionKeys(result.sections)).toEqual(["today", "yesterday", "earlier"]);
  });

  it("counts several hidden work orders", () => {
    const result = buildHomeSections(
      [
        row("a", "# one", "idle", NOW),
        row("b", "# two", "idle", NOW),
        row("c", "plain", "idle", NOW),
      ],
      NOW,
      false,
    );
    expect(result.hiddenWorkOrders).toBe(2);
    expect(itemsIn(result.sections, "today").map((s) => s.id)).toEqual(["c"]);
  });
});

describe("groupSessions stays available", () => {
  it("still groups by recency for the plain buckets", () => {
    const sections = groupSessions([row("x", "X", "idle", NOW)], NOW);
    expect(sections.map((section) => section.key)).toEqual(["today"]);
  });
});
