export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseCodexCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed) return { name: "help", args: "" };
  const [name, ...rest] = trimmed.split(/\s+/);
  return { name: name.toLowerCase(), args: rest.join(" ").trim() };
}

export function splitFirstArg(args: string): { first?: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { rest: "" };
  const [first, ...rest] = trimmed.split(/\s+/);
  return { first, rest: rest.join(" ").trim() };
}

export function parsePositiveOrdinal(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}
