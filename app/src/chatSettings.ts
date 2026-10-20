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
}

export function emptyChatSettings(): ChatSettings {
  return {
    model: null,
    models: [],
    thoughtLevels: [],
    thoughtLevel: null,
    contextUsed: null,
    contextWindow: null,
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

    return { model, models, thoughtLevels, thoughtLevel, contextUsed, contextWindow };
  } catch {
    return emptyChatSettings();
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
