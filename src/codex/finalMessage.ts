function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromContent(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isObject(item)) return [];
    if (typeof item.text === "string") return [item.text];
    if (typeof item.content === "string") return [item.content];
    return [];
  });
}

function collectAssistantText(value: unknown): string[] {
  if (!isObject(value)) return [];
  const role = value.role;
  const type = value.type;
  const looksAssistant = role === "assistant" || type === "assistant_message" || type === "message";
  const direct = looksAssistant ? [...textFromContent(value.content), ...textFromContent(value.parts), ...textFromContent(value.text)] : [];
  return [
    ...direct,
    ...Object.values(value).flatMap((child) => {
      if (child === value) return [];
      if (Array.isArray(child)) return child.flatMap(collectAssistantText);
      if (isObject(child)) return collectAssistantText(child);
      return [];
    }),
  ];
}

export function extractFinalMessage(turn: unknown): string {
  const texts = collectAssistantText(turn)
    .map((text) => text.trim())
    .filter(Boolean);
  return texts.at(-1) ?? "Codex completed the turn without a final text message.";
}
