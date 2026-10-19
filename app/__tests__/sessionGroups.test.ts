import { groupSessions } from "../src/sessionGroups";
import type { SessionSection } from "../src/sessionGroups";

const NOW = new Date("2026-10-19T15:00:00").getTime();
const TODAY_START = new Date("2026-10-19T00:00:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function row(id: string, status: string, updatedAt: number | null) {
  return { id, title: id, folder: "wt", status, updatedAt };
}

function titles(sections: SessionSection[]): string[] {
  return sections.map((section) => section.title);
}

function sectionOf(sections: SessionSection[], id: string): string | undefined {
  return sections.find((section) => section.items.some((item) => item.id === id))?.title;
}

it("groups waiting and error sessions under Needs you", () => {
  const sections = groupSessions([row("a", "waiting", NOW), row("b", "error", NOW)], NOW);
  expect(titles(sections)).toEqual(["Needs you"]);
  expect(sections[0]?.items.map((s) => s.id)).toEqual(["a", "b"]);
});

it("groups running sessions separately from idle ones", () => {
  const sections = groupSessions([row("run", "running", NOW), row("idle", "idle", NOW)], NOW);
  expect(titles(sections)).toEqual(["Running", "Today"]);
  expect(sectionOf(sections, "run")).toBe("Running");
  expect(sectionOf(sections, "idle")).toBe("Today");
});

it("buckets by local midnight, one day and seven days", () => {
  const sections = groupSessions(
    [
      row("t", "idle", TODAY_START),
      row("y", "idle", TODAY_START - 1),
      row("y2", "idle", TODAY_START - DAY),
      row("w", "idle", TODAY_START - DAY - 1),
      row("p7", "idle", TODAY_START - 7 * DAY),
      row("old", "idle", TODAY_START - 7 * DAY - 1),
    ],
    NOW,
  );
  expect(sectionOf(sections, "t")).toBe("Today");
  expect(sectionOf(sections, "y")).toBe("Yesterday");
  expect(sectionOf(sections, "y2")).toBe("Yesterday");
  expect(sectionOf(sections, "w")).toBe("Previous 7 days");
  expect(sectionOf(sections, "p7")).toBe("Previous 7 days");
  expect(sectionOf(sections, "old")).toBe("Earlier");
});

it("puts sessions without updatedAt in Earlier", () => {
  expect(titles(groupSessions([row("x", "idle", null)], NOW))).toEqual(["Earlier"]);
});

it("treats unknown statuses as plain sessions", () => {
  expect(titles(groupSessions([row("u", "compacting", NOW)], NOW))).toEqual(["Today"]);
});

it("sorts each section by recency, newest first", () => {
  const sections = groupSessions(
    [row("old-today", "idle", TODAY_START), row("new-today", "idle", NOW)],
    NOW,
  );
  expect(sections[0]?.items.map((s) => s.id)).toEqual(["new-today", "old-today"]);
});

it("drops empty sections entirely", () => {
  const sections = groupSessions([row("only", "idle", NOW)], NOW);
  expect(titles(sections)).toEqual(["Today"]);
});
