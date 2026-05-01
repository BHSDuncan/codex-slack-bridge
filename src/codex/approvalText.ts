import type { ApprovalRequest } from "../types.js";

export function summarizeApproval(request: ApprovalRequest): string {
  const command = request.command?.join(" ") ?? "unknown command";
  const reason = request.reason?.trim();
  if (reason) return reason;
  if (request.method.includes("fileChange")) return "Codex wants to apply a file change needed for the current task.";
  if (request.method.includes("permissions")) return "Codex is requesting broader permissions needed to continue the current task.";
  if (command.includes("npm install")) return "Codex needs to install project dependencies before it can run or verify the bridge.";
  if (command.includes("codex app-server")) return "Codex needs to start the local app-server so Slack can control local Codex sessions.";
  if (command.includes("git")) return "Codex wants to inspect or update repository state for the current task.";
  return "Codex needs this approval to continue the current turn.";
}

export function formatApprovalMessage(request: ApprovalRequest): string {
  const lines = [
    "*Codex needs approval*",
    summarizeApproval(request),
    request.cwd ? `*cwd:* \`${request.cwd}\`` : undefined,
    request.command?.length ? `*command:* \`${request.command.join(" ")}\`` : undefined,
  ];
  return lines.filter(Boolean).join("\n");
}
