import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BridgeConfig,
  CodexAdapter,
  CodexSessionSummary,
  TurnResult,
} from "../types.js";
import { extractFinalMessage } from "./finalMessage.js";
import { listCodexSessions } from "./sessionIndex.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function threadIdFromResponse(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const thread = response.thread;
  if (isRecord(thread)) {
    return typeof thread.id === "string" ? thread.id : typeof thread.threadId === "string" ? thread.threadId : undefined;
  }
  return typeof response.threadId === "string" ? response.threadId : undefined;
}

function turnIdFromResponse(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const turn = response.turn;
  if (isRecord(turn)) {
    return typeof turn.id === "string" ? turn.id : typeof turn.turnId === "string" ? turn.turnId : undefined;
  }
  return typeof response.turnId === "string" ? response.turnId : undefined;
}

function approvalThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return (
    (typeof params.threadId === "string" && params.threadId) ||
    (typeof params.conversationId === "string" && params.conversationId) ||
    undefined
  );
}

function commandFromApproval(params: unknown): string[] | undefined {
  if (!isRecord(params)) return undefined;
  if (Array.isArray(params.command) && params.command.every((part) => typeof part === "string")) return params.command;
  if (typeof params.command === "string") return [params.command];
  if (Array.isArray(params.argv) && params.argv.every((part) => typeof part === "string")) return params.argv;
  return undefined;
}

export class AppServerCodexAdapter implements CodexAdapter {
  private config: BridgeConfig;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private emitter = new EventEmitter();
  private activeTurns = new Map<string, { resolve: (result: TurnResult) => void; reject: (error: Error) => void }>();
  private activeTurnIdsByThread = new Map<string, string>();
  private finalMessagesByThread = new Map<string, string>();

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.config.codexBin, ["app-server"], {
      cwd: this.config.defaultCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const request of this.pending.values()) request.reject(error);
      for (const turn of this.activeTurns.values()) turn.reject(error);
      this.pending.clear();
      this.activeTurns.clear();
      this.child = undefined;
    });

    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[codex app-server] ${chunk.toString()}`);
    });

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "codex-slack-bridge", title: "Codex Slack Bridge", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/started",
          "item/rawResponseItem/completed",
          "item/reasoningSummaryPart/added",
        ],
      },
    });
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
  }

  async createThread(prompt: string, cwd = this.config.defaultCwd): Promise<TurnResult> {
    const threadId = await this.createEmptyThread(cwd);
    return this.startTurn(threadId, prompt, cwd);
  }

  async createEmptyThread(cwd = this.config.defaultCwd): Promise<string> {
    await this.start();
    const response = await this.request("thread/start", this.threadParams(cwd));
    const threadId = threadIdFromResponse(response);
    if (!threadId) throw new Error("Codex did not return a thread id for thread/start");
    return threadId;
  }

  async runTurn(threadId: string, prompt: string, cwd = this.config.defaultCwd): Promise<TurnResult> {
    return this.startTurn(threadId, prompt, cwd);
  }

  async steerThread(threadId: string, prompt: string): Promise<void> {
    const expectedTurnId = this.activeTurnIdsByThread.get(threadId);
    if (!expectedTurnId) {
      throw new Error(`No active steerable turn is known for Codex thread ${threadId}`);
    }
    await this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text: prompt }],
    });
  }

  async resumeThread(threadId: string, prompt: string, cwd = this.config.defaultCwd): Promise<TurnResult> {
    await this.start();
    await this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      model: this.config.model ?? null,
    });
    return this.startTurn(threadId, prompt, cwd);
  }

  async attachThread(threadId: string, cwd = this.config.defaultCwd): Promise<void> {
    await this.start();
    await this.request("thread/resume", {
      threadId,
      cwd,
      excludeTurns: true,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      model: this.config.model ?? null,
    });
  }

  async listSessions(): Promise<CodexSessionSummary[]> {
    return listCodexSessions();
  }

  async approve(decision: ApprovalDecision): Promise<void> {
    const pending = this.pending.get(decision.requestId);
    if (!pending) throw new Error(`No pending approval request ${decision.requestId}`);
    pending.resolve({ decision: decision.decision });
    this.pending.delete(decision.requestId);
  }

  onFinalMessage(handler: (result: TurnResult) => Promise<void>): void {
    this.emitter.on("final", handler);
  }

  onApprovalRequest(handler: (request: ApprovalRequest) => Promise<void>): void {
    this.emitter.on("approval", handler);
  }

  private threadParams(cwd: string): Record<string, unknown> {
    return {
      cwd,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      model: this.config.model ?? null,
    };
  }

  private async startTurn(threadId: string, prompt: string, cwd: string): Promise<TurnResult> {
    const response = await this.request("turn/start", {
      threadId,
      cwd,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      input: [{ type: "text", text: prompt }],
    });
    const turnId = turnIdFromResponse(response);
    return new Promise((resolve, reject) => {
      this.activeTurns.set(turnId ?? threadId, { resolve, reject });
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private respond(id: string | number, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`[codex app-server] ${line}\n`);
      return;
    }
    if (!isRecord(message)) return;

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const pending = this.pending.get(message.id as string | number);
      if (!pending) return;
      this.pending.delete(message.id as string | number);
      if ("error" in message) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    if ("id" in message) {
      void this.handleServerRequest(message as { id: string | number; method: string; params?: unknown });
      return;
    }
    this.handleNotification(message.method, message.params);
  }

  private async handleServerRequest(request: { id: string | number; method: string; params?: unknown }): Promise<void> {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "execCommandApproval"
    ) {
      this.pending.set(request.id, {
        resolve: (result) => this.respond(request.id, result),
        reject: () => this.respond(request.id, { decision: "denied" }),
      });
      const params = isRecord(request.params) ? request.params : {};
      await this.emitApproval({
        id: request.id,
        method: request.method,
        threadId: approvalThreadId(request.params),
        command: commandFromApproval(request.params),
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        reason: typeof params.reason === "string" ? params.reason : null,
        raw: request.params,
      });
      return;
    }

    if (request.method === "item/tool/requestUserInput" || request.method === "mcpServer/elicitation/request") {
      this.respond(request.id, { answers: [] });
      return;
    }

    this.respond(request.id, null);
  }

  private async emitApproval(request: ApprovalRequest): Promise<void> {
    const listeners = this.emitter.listeners("approval") as Array<(approval: ApprovalRequest) => Promise<void>>;
    await Promise.all(listeners.map((listener) => listener(request)));
  }

  handleNotificationForTest(method: string, params: unknown): void {
    this.handleNotification(method, params);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "turn/started" && isRecord(params)) {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = turnIdFromResponse(params);
      if (threadId && turnId) this.activeTurnIdsByThread.set(threadId, turnId);
      return;
    }

    if (method === "item/completed" && isRecord(params)) {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const item = params.item;
      if (threadId && isRecord(item) && item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
        this.finalMessagesByThread.set(threadId, item.text);
      }
      return;
    }

    if (method !== "turn/completed" || !isRecord(params)) return;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    this.activeTurnIdsByThread.delete(threadId);
    const finalMessage = this.finalMessagesByThread.get(threadId) ?? extractFinalMessage(params.turn);
    this.finalMessagesByThread.delete(threadId);
    const result = { threadId, finalMessage };
    for (const [key, turn] of this.activeTurns.entries()) {
      if (key === threadId || key === turnIdFromResponse(params)) {
        turn.resolve(result);
        this.activeTurns.delete(key);
        break;
      }
    }
    this.emitter.emit("final", result);
  }
}
