export const DEFAULT_MODEL_SELECTION = {
  providerId: "account:zai-individual-coding-plan",
  modelId: "GLM-5.3-Flash",
  options: { reasoningLevel: "max" },
};

// The relay refuses yolo/build; guarded permission requests cannot be answered
// from the phone, so only plan and edit are offered.
export const SESSION_MODES = ["plan", "edit"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const PRIVACY_URL = "https://github.com/zrll2/zode/blob/main/docs/PRIVACY.md";
export const SUPPORT_URL = "https://github.com/zrll2/zode/issues";

// Push notifications: registration service (placeholder until deployed) and
// the keychain access group the push key shares with the notification
// extension (team prefix + shared suffix; SecureStore passes it verbatim).
export const PUSH_SERVICE_URL = "https://zode-push.vercel.app";
export const PUSH_KEYCHAIN_GROUP = "XP5Q8LPH52.sg.comex.zode.shared";
export const BUNDLE_ID = "sg.comex.zode";
