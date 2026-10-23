// Relay protocol versions the phone needs for each feature. A relay that
// never sends `protocol` in its ready frame counts as protocol 1.
export const MIN_PROTOCOL = {
  rename: 2,
  usage: 2,
  attachments: 2,
  askFirst: 2,
} as const;

export type Feature = keyof typeof MIN_PROTOCOL;

// The protocol version the relay announced; undefined or a non-number means
// an older relay (protocol 1).
function effectiveProtocol(protocol: number | undefined): number {
  return typeof protocol === "number" && Number.isFinite(protocol) ? protocol : 1;
}

export function relaySupports(
  protocol: number | undefined,
  feature: Feature,
): boolean {
  return effectiveProtocol(protocol) >= MIN_PROTOCOL[feature];
}

// Highest minimum across features, so one number captures "current relay".
const CURRENT_PROTOCOL = Math.max(...Object.values(MIN_PROTOCOL));

export function isOutdated(protocol: number | undefined): boolean {
  return effectiveProtocol(protocol) < CURRENT_PROTOCOL;
}

// features are plain phrases, e.g. ["rename chats", "see usage"].
export function outdatedMessage(features: string[]): string {
  const list =
    features.length <= 1
      ? features.join("")
      : `${features.slice(0, -1).join(", ")}, and ${features[features.length - 1]}`;
  return `Your Mac is running an older Zode. Update Zode on your Mac to ${list}.`;
}
