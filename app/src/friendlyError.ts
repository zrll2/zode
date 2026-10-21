// Plain-language versions of the connection and pairing errors, for people who never saw a terminal.
const UNREACHABLE =
  "Can't reach your Mac. Check that it is awake, that Zode is open on it (look for the Z in the menu bar), and that this phone is on the same Wi-Fi, or on Tailscale.";
const BAD_CODE =
  "This code didn't work. It may have expired. On your Mac, click the Z in the menu bar, choose Pair a phone…, and scan the new code.";
const NOT_A_CODE =
  "That doesn't look like a Zode pairing code. On your Mac, click the Z in the menu bar, choose Pair a phone…, and scan the code shown there.";

export function friendlyError(raw: unknown, context: "pair" | "connect" = "connect"): string {
  const text = String((raw as any)?.message ?? raw ?? "").trim();
  if (!text) return context === "pair" ? "Pairing didn't work. Please try again." : "Something went wrong. Please try again.";
  if (/pairing rejected|bad token|invalid or expired|expired|unauthori[sz]ed|HTTP 40[13]/i.test(text)) return context === "pair" ? BAD_CODE : "This phone is no longer paired with the Mac. Pair it again from Pair a phone… in the Zode menu bar.";
  if (/not valid JSON|missing u, w or c|must start with ws|unexpected pairing response/i.test(text)) return NOT_A_CODE;
  if (/timed out|timeout|network request failed|not connected|closed before ready|relay: closed|disconnected|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|failed to fetch|HTTP 5\d\d/i.test(text)) return UNREACHABLE;
  return text;
}
