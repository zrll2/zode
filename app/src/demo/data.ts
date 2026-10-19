// Fictional sample data for demo mode. Generic names only: everything lives
// under /Users/demo/projects/ (order 11).

export interface DemoSessionRecord {
  sessionId: string;
  title: string;
  folder: string;
  status: "idle" | "running" | "waiting" | "error";
  minutesAgo: number;
  // absolute override once the demo touched the session
  updatedAt?: number;
}

export const DEMO_SERVERS = [
  { pid: 101, cwd: "/Users/demo/projects/shop-api" },
  { pid: 102, cwd: "/Users/demo/projects/web-app" },
  { pid: 103, cwd: "/Users/demo/projects/docs-site" },
  { pid: 104, cwd: "/Users/demo/projects/mobile-app" },
];

export const RUNNING_SESSION_ID = "demo-port-settings";

export const DEMO_REPLY =
  "This is a demo reply. In real use, ZCode would do the work on your Mac.";

export const RUNNING_TURN_INPUT = "Port the settings page to the new design.";
export const RUNNING_TURN_TEXT =
  "Moving the section headers into a shared component so every settings group looks the same. The toggle row stays at the top of the page.";

export function initialDemoSessions(): DemoSessionRecord[] {
  return [
    { sessionId: "demo-login-redirect", title: "Fix login redirect loop", folder: "shop-api", status: "waiting", minutesAgo: 2 },
    { sessionId: "demo-port-settings", title: "Port settings page to the new design", folder: "web-app", status: "running", minutesAgo: 4 },
    { sessionId: "demo-dark-mode", title: "Add dark mode toggle", folder: "web-app", status: "idle", minutesAgo: 120 },
    { sessionId: "demo-getting-started", title: "Write the getting started guide", folder: "docs-site", status: "idle", minutesAgo: 180 },
    { sessionId: "demo-expo-58", title: "Upgrade to Expo SDK 58", folder: "mobile-app", status: "idle", minutesAgo: 1500 },
    { sessionId: "demo-search-query", title: "Speed up the search query", folder: "shop-api", status: "idle", minutesAgo: 1560 },
    { sessionId: "demo-rate-limiting", title: "Add rate limiting to the API", folder: "shop-api", status: "error", minutesAgo: 4320 },
    { sessionId: "demo-ci-checks", title: "Add CI checks for pull requests", folder: "docs-site", status: "idle", minutesAgo: 11520 },
  ];
}

export interface DemoSessionListItem {
  sessionId: string;
  title: string;
  titleSource: string;
  status: DemoSessionRecord["status"];
  mode: string;
  createdAt: number;
  updatedAt: number;
  workspace: { workspacePath: string; workspaceKey: string };
  sessionKind: string;
}

// Same shape the real server returns for session/list.
export function buildSessionList(
  sessions: DemoSessionRecord[],
  now: number,
): DemoSessionListItem[] {
  return sessions.map((session) => {
    const updatedAt = session.updatedAt ?? now - session.minutesAgo * 60_000;
    return {
      sessionId: session.sessionId,
      title: session.title,
      titleSource: "first_input",
      status: session.status,
      mode: "edit",
      createdAt: updatedAt - 60 * 60_000,
      updatedAt,
      workspace: {
        workspacePath: `/Users/demo/projects/${session.folder}`,
        workspaceKey: session.folder,
      },
      sessionKind: "regular",
    };
  });
}

// Same shape the real server returns for session/messages.
export function demoHistory(sessionId: string, now: number): any[] {
  if (sessionId === "demo-dark-mode") return darkModeHistory(now);
  if (sessionId === "demo-login-redirect") return loginRedirectHistory(now);
  return [];
}

function message(id: string, role: "user" | "assistant", created: number, parts: any[]) {
  return {
    info: { id, role, time: role === "assistant" ? { created, completed: created + 90_000 } : { created } },
    parts,
  };
}

function darkModeHistory(now: number) {
  const base = now - 120 * 60_000;
  const readInput = JSON.stringify({ filePath: "app/settings.tsx" });
  const editInput = JSON.stringify({ filePath: "app/_layout.tsx" });
  const bashInput = JSON.stringify({ command: "npm test -- settings" });
  return [
    message("demo-msg-u1", "user", base, [
      {
        type: "text",
        text: "Add a dark mode toggle to the settings page. It should follow the system theme by default and let people override it manually.",
      },
    ]),
    message("demo-msg-a1", "assistant", base + 1000, [
      {
        type: "reasoning",
        text: "The settings page needs a three-state control: system, light, dark. Store an explicit override in the settings store and resolve it against the OS scheme in the root layout, so the first paint already uses the right colors.",
      },
      {
        type: "tool",
        tool: "Read",
        callID: "demo-call-read-theme",
        state: {
          status: "result",
          input: readInput,
          output:
            "export default function Settings() {\n  return (\n    <ScrollView>\n      <Section title=\"General\">…</Section>\n      <Section title=\"About\">…</Section>\n    </ScrollView>\n  );\n}",
        },
      },
      {
        type: "text",
        text: "Here is the plan:\n\n- Follow the **system theme** by default\n- Store an explicit override with `settingsStorage.set(\"theme\", value)`\n- Apply the resolved theme in `RootLayout` before the first paint\n\n| Choice | Behavior |\n| --- | --- |\n| system | track the OS setting |\n| light | always light colors |\n| dark | always dark colors |",
      },
      {
        type: "tool",
        tool: "Edit",
        callID: "demo-call-edit-layout",
        state: {
          status: "result",
          input: editInput,
          output: "Applied 2 edits to app/_layout.tsx",
        },
      },
      {
        type: "tool",
        tool: "Bash",
        callID: "demo-call-bash-test",
        state: {
          status: "result",
          input: bashInput,
          output: "PASS  __tests__/settings.test.ts\nTests: 14 passed, 14 total",
        },
      },
      {
        type: "text",
        text: "## Done\n\nDark mode toggle added. 14 tests pass.\n\nThe toggle sits at the top of the settings page:\n\n```ts\nconst osScheme = useColorScheme();\nconst stored = settingsStorage.get(\"theme\");\nconst theme = stored === \"system\" || stored === null ? osScheme : stored;\napplyTheme(theme);\nuseEffect(() => {\n  applyTheme(theme);\n}, [theme]);\n```",
      },
    ]),
  ];
}

function loginRedirectHistory(now: number) {
  const base = now - 2 * 60_000;
  const readInput = JSON.stringify({ filePath: "src/router.ts" });
  const editInput = JSON.stringify({ filePath: "src/router.ts" });
  return [
    message("demo-msg-u2", "user", base, [
      {
        type: "text",
        text: "Signing in sends me back to the login page in a loop. Can you find out why?",
      },
    ]),
    message("demo-msg-a2", "assistant", base + 800, [
      {
        type: "text",
        text: "The route guard sends you to `/login` whenever the session is empty, but the token is restored *after* the guard runs — so the first navigation after a refresh always bounces.",
      },
      {
        type: "tool",
        tool: "Read",
        callID: "demo-call-read-router",
        state: {
          status: "result",
          input: readInput,
          output:
            "router.beforeEach((to) => {\n  if (to.meta.requiresAuth && !session.user) {\n    return \"/login\";\n  }\n});",
        },
      },
      {
        type: "tool",
        tool: "Edit",
        callID: "demo-call-edit-router",
        state: { status: "started", input: editInput, output: "" },
      },
    ]),
  ];
}
