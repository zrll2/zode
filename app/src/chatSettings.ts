// Parsing and builders for the chat settings surface (order 17c). Missing or
// odd data yields empty arrays and nulls — never throws.

export interface ChatModelInfo {
  providerId: string;
  modelId: string;
  label: string;
  reasoningLevel: string | null;
}

export interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  providerLabel: string;
  reasoningLevels: string[];
  defaultLevel: string | null;
}

export interface ChatSettings {
  model: ChatModelInfo | null;
  models: ModelOption[];
  thoughtLevels: string[];
  thoughtLevel: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  mode: string | null;
}

export function emptyChatSettings(): ChatSettings {
  return {
    model: null,
    models: [],
    thoughtLevels: [],
    thoughtLevel: null,
    contextUsed: null,
    contextWindow: null,
    mode: null,
  };
}

function levelValues(levels: unknown): string[] {
  return Array.isArray(levels)
    ? levels
        .filter((level) => level && typeof level.value === "string")
        .map((level) => level.value as string)
    : [];
}

export function parseChatSettings(resumeResult: unknown): ChatSettings {
  try {
    const root = (resumeResult ?? {}) as Record<string, any>;
    const settings = root.settings;
    if (!settings || typeof settings !== "object") return emptyChatSettings();

    let model: ChatModelInfo | null = null;
    const current = settings.model?.current;
    if (current && typeof current.providerId === "string" && typeof current.modelId === "string") {
      model = {
        providerId: current.providerId,
        modelId: current.modelId,
        label: current.modelId,
        reasoningLevel:
          typeof current.options?.reasoningLevel === "string"
            ? current.options.reasoningLevel
            : null,
      };
    }

    const models: ModelOption[] = [];
    const available = settings.model?.available;
    if (Array.isArray(available)) {
      for (const entry of available) {
        const ref = entry?.ref;
        if (!ref || typeof ref.providerId !== "string" || typeof ref.modelId !== "string") {
          continue;
        }
        models.push({
          providerId: ref.providerId,
          modelId: ref.modelId,
          label: typeof entry.label === "string" ? entry.label : ref.modelId,
          providerLabel: typeof entry.providerLabel === "string" ? entry.providerLabel : "",
          reasoningLevels: levelValues(entry.reasoning?.levels),
          defaultLevel:
            typeof entry.reasoning?.defaultLevel === "string"
              ? entry.reasoning.defaultLevel
              : null,
        });
      }
    }

    const thought = settings.thoughtLevel;
    const thoughtLevels = thought ? levelValues(thought.available) : [];
    const thoughtLevel =
      thought && typeof thought.current === "string" ? thought.current : null;

    const projection = root.projection;
    const contextUsed =
      projection && typeof projection.contextUsed === "number" ? projection.contextUsed : null;
    const contextWindow =
      projection && typeof projection.contextWindow === "number"
        ? projection.contextWindow
        : null;
    // settings.mode.current first, projection.mode as fallback.
    const mode =
      settings.mode && typeof settings.mode.current === "string"
        ? settings.mode.current
        : projection && typeof projection.mode === "string"
          ? projection.mode
          : null;

    return { model, models, thoughtLevels, thoughtLevel, contextUsed, contextWindow, mode };
  } catch {
    return emptyChatSettings();
  }
}

// The phone may only switch between these; build/yolo/auto are read-only
// states shown as "Full access".
const PHONE_MODES = ["plan", "edit", "guarded"];

export function isPhoneSelectableMode(mode: string): boolean {
  return PHONE_MODES.includes(mode);
}

export function buildSetModeParams(sessionId: string, mode: string) {
  if (!isPhoneSelectableMode(mode)) {
    throw new Error(`Mode "${mode}" is not available on the phone.`);
  }
  return { sessionId, mode };
}

// Plain names for the thinking levels (the raw ids are low, high and max).
export function thinkingLabel(level: string): string {
  switch (level) {
    case "low":
      return "Quick";
    case "high":
      return "Balanced";
    case "max":
      return "Deep";
    default:
      return level ? level.charAt(0).toUpperCase() + level.slice(1) : level;
  }
}

// Pill label for the current mode; null when unknown.
export function permissionLabel(mode: string): string | null {
  switch (mode) {
    case "plan":
      return "Read only";
    case "edit":
      return "Edit files";
    case "guarded":
      return "Ask first";
    case "build":
    case "yolo":
    case "auto":
      return "Full access";
    default:
      return null;
  }
}

// Keep the current reasoning level when the new model supports it; callers
// pass undefined to fall back to the model's own default.
export function buildSetModelParams(
  sessionId: string,
  option: ModelOption,
  reasoningLevel?: string,
) {
  const model: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel: string };
  } = { providerId: option.providerId, modelId: option.modelId };
  if (reasoningLevel) model.options = { reasoningLevel };
  return { sessionId, model };
}

export function buildSetThoughtLevelParams(sessionId: string, level: string) {
  return { sessionId, thoughtLevel: level };
}

export function buildRenameParams(sessionId: string, title: string) {
  return { sessionId, title: title.trim().slice(0, 120) };
}
