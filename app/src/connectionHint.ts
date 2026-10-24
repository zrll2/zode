// Why can't the phone reach the Mac, in plain words? Pure: the screen picks
// the branch, this module only words it. No React and no network.

export type ConnectionHintActionKind = "scan" | "tailscale" | "retry";

export interface ConnectionHintAction {
  label: string;
  kind: ConnectionHintActionKind;
  quiet?: boolean;
}

export interface ConnectionHint {
  title: string;
  body: string;
  actions: ConnectionHintAction[];
}

export interface ConnectionHintInput {
  urls: string[]; // every relay address the phone knows
  lastGood: string | null; // the address that last worked
  status: string; // "ready" means connected; the hint is only for downtime
  secondsDisconnected: number;
}

// Tailscale addresses live in 100.64.0.0/10; home Wi-Fi in private ranges.
const TAILSCALE_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const LAN_RE =
  /^192\.168\.\d{1,3}\.\d{1,3}$|^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;

function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url ?? "");
  return (match?.[1] ?? "").replace(/:\d+$/, "").toLowerCase();
}

export function isTailscaleAddress(url: string): boolean {
  return TAILSCALE_RE.test(hostOf(url));
}

export function isPrivateLanAddress(url: string): boolean {
  return LAN_RE.test(hostOf(url));
}

export type OfflineView = "dots" | "hint" | "skeleton" | "list";

// What the home screen shows, given the relay status, whether the session
// list has loaded at least once, and whether the plain-words hint is up:
// - ready and loaded → the list.
// - ready but the first load is still running → skeleton rows (the only
//   place skeletons appear).
// - offline → the hint once it has something to say, else the centred dots.
export function offlineView(options: {
  status: string;
  connectedOnce: boolean;
  hint: boolean;
}): OfflineView {
  if (options.status === "ready") return options.connectedOnce ? "list" : "skeleton";
  return options.hint ? "hint" : "dots";
}

// The first seconds of a drop are just a reconnect: say nothing yet. After
// that the known addresses tell us which story is true:
// - home Wi-Fi only (and we have connected before): this phone never learned
//   Tailscale — open Zode at home once, or re-pair.
// - a Tailscale address is known and there is no better guess: away from
//   home — Tailscale on the phone must be on.
// - everything else: the plain "is the Mac awake" advice.
export function connectionHint(input: ConnectionHintInput): ConnectionHint | null {
  if (input.status === "ready") return null;
  if (input.secondsDisconnected < 8) return null;

  const urls = Array.isArray(input.urls) ? input.urls : [];
  const hasTailscale = urls.some(isTailscaleAddress);
  const hasLan = urls.some(isPrivateLanAddress);
  const lastGoodIsTailscale = input.lastGood ? isTailscaleAddress(input.lastGood) : false;

  if (!hasTailscale) {
    if (input.lastGood) {
      return {
        title: "Your phone only knows your home Wi-Fi",
        body:
          "Open Zode once while you are on your home Wi-Fi so it can learn the other way in (Tailscale), or scan the pairing code again.",
        actions: [{ label: "Scan code again", kind: "scan" }],
      };
    }
    return {
      title: "Can't reach your Mac",
      body: "Your Mac is not reachable. Check that it is awake and on the same Wi-Fi.",
      actions: [{ label: "Try again", kind: "retry" }],
    };
  }

  if (!hasLan || !input.lastGood || lastGoodIsTailscale) {
    return {
      title: "Can't reach your Mac from here",
      body:
        "You are away from your home Wi-Fi. Open Tailscale on this phone and make sure it is connected, then try again. Your Mac must be awake with Zode open.",
      actions: [
        { label: "Open Tailscale", kind: "tailscale" },
        { label: "Try again", kind: "retry", quiet: true },
      ],
    };
  }

  return {
    title: "Can't reach your Mac",
    body: "Your Mac is not reachable. Check that it is awake and on the same Wi-Fi.",
    actions: [{ label: "Try again", kind: "retry" }],
  };
}
