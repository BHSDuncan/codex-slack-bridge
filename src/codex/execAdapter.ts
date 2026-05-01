import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BridgeConfig,
  CodexAdapter,
  CodexSessionSummary,
  TurnResult,
  UserInputRequest,
} from "../types.js";
import { listCodexSessions } from "./sessionIndex.js";

const execFileAsync = promisify(execFile);

export class ExecCodexAdapter implements CodexAdapter {
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createThread(prompt: string, cwd = this.config.defaultCwd): Promise<TurnResult> {
    const args = ["exec", "--json", "-C", cwd, "-a", "never"];
    if (this.config.model) args.push("-m", this.config.model);
    if (this.config.profile) args.push("-p", this.config.profile);
    args.push(prompt);
    const { stdout } = await execFileAsync(this.config.codexBin, args, { cwd, maxBuffer: 1024 * 1024 * 10 });
    return { threadId: "unknown", finalMessage: extractLastMessage(stdout) };
  }

  async resumeThread(threadId: string, prompt: string, cwd = this.config.defaultCwd): Promise<TurnResult> {
    const args = ["exec", "resume", "--json", threadId, prompt];
    const { stdout } = await execFileAsync(this.config.codexBin, args, { cwd, maxBuffer: 1024 * 1024 * 10 });
    return { threadId, finalMessage: extractLastMessage(stdout) };
  }

  async attachThread(): Promise<void> {
    throw new Error("Live attach is not supported by the exec fallback adapter");
  }

  async listSessions(): Promise<CodexSessionSummary[]> {
    return listCodexSessions();
  }

  async approve(_decision: ApprovalDecision): Promise<void> {
    throw new Error("The exec fallback adapter does not support approvals");
  }

  onFinalMessage(): void {}

  onApprovalRequest(_handler: (request: ApprovalRequest) => Promise<void>): void {}

  onUserInputRequest(_handler: (request: UserInputRequest) => Promise<void>): void {}
}

function extractLastMessage(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as { msg?: { message?: string }; message?: string; type?: string };
      if (typeof parsed.message === "string") return parsed.message;
      if (typeof parsed.msg?.message === "string") return parsed.msg.message;
    } catch {
      if (!line.startsWith("{")) return line;
    }
  }
  return "Codex completed the turn without a final text message.";
}
