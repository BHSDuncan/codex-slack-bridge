import type { CodexSessionSummary, SessionRecord } from "../types.js";

export function helpText(): string {
  return [
    "*Codex Slack Bridge*",
    "`/codex enable` - enable local Codex access",
    "`/codex disable` - disable local Codex access",
    "`/codex status` - show bridge status",
    "`/codex list` - list recent Codex sessions",
    "`/codex new <prompt>` - start a new Codex session",
    "`/codex resume <session-id-or-name> [prompt]` - bind a Codex session to a Slack thread",
    "`/codex attach <session-id-or-name>` - attach a Slack thread to an existing Codex session",
  ].join("\n");
}

export function formatSessionList(sessions: CodexSessionSummary[]): string {
  if (sessions.length === 0) return "No Codex sessions were found in the local session index.";
  return sessions
    .slice(0, 20)
    .map((session) => {
      const name = session.threadName ? ` - ${session.threadName}` : "";
      const cwd = !session.threadName && session.cwd ? ` - ${session.cwd}` : "";
      const updated = session.updatedAt ? ` (${session.updatedAt})` : "";
      return `\`${session.id}\`${name}${cwd}${updated}`;
    })
    .join("\n");
}

export function formatBridgeSessions(records: SessionRecord[]): string {
  if (records.length === 0) return "No Slack threads are currently mapped to Codex sessions.";
  return records
    .slice(0, 20)
    .map((record) => `\`${record.codexThreadId}\` - <#${record.slackChannelId}> thread ${record.slackThreadTs}${record.title ? ` - ${record.title}` : ""}`)
    .join("\n");
}

export function sessionTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "Codex session";
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}
