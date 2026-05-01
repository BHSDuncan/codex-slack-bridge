import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import type { MirroredApprovalNotice, MirroredTurnComplete } from "../types.js";

type CompleteHandler = (event: MirroredTurnComplete) => Promise<void>;
type ApprovalHandler = (event: MirroredApprovalNotice) => Promise<void>;

interface MirrorState {
  threadId: string;
  rolloutPath: string;
  position: number;
  buffer: string;
  reading: boolean;
  watcher?: FSWatcher;
  poller?: NodeJS.Timeout;
  seenApprovals: Set<string>;
  onComplete: CompleteHandler;
  onApproval: ApprovalHandler;
}

interface ParsedRolloutEvent {
  complete?: Omit<MirroredTurnComplete, "threadId">;
  approval?: Omit<MirroredApprovalNotice, "threadId">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class RolloutMirror {
  private mirrors = new Map<string, MirrorState>();
  private pollMs: number;

  constructor(pollMs = 1000) {
    this.pollMs = pollMs;
  }

  async watch(
    threadId: string,
    rolloutPath: string,
    onComplete: CompleteHandler,
    onApproval: ApprovalHandler,
  ): Promise<void> {
    await this.unwatch(threadId);
    const stat = await fsp.stat(rolloutPath);
    const state: MirrorState = {
      threadId,
      rolloutPath,
      position: stat.size,
      buffer: "",
      reading: false,
      seenApprovals: new Set(),
      onComplete,
      onApproval,
    };
    state.watcher = fs.watch(rolloutPath, () => {
      void this.readNewBytes(state);
    });
    state.poller = setInterval(() => {
      void this.readNewBytes(state);
    }, this.pollMs);
    this.mirrors.set(threadId, state);
  }

  async unwatch(threadId: string): Promise<void> {
    const existing = this.mirrors.get(threadId);
    if (!existing) return;
    existing.watcher?.close();
    if (existing.poller) clearInterval(existing.poller);
    this.mirrors.delete(threadId);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.mirrors.keys()].map((threadId) => this.unwatch(threadId)));
  }

  async handleLineForTest(threadId: string, line: string): Promise<ParsedRolloutEvent> {
    return parseRolloutLine(threadId, line);
  }

  private async readNewBytes(state: MirrorState): Promise<void> {
    if (state.reading) return;
    state.reading = true;
    try {
      const stat = await fsp.stat(state.rolloutPath);
      if (stat.size < state.position) {
        state.position = stat.size;
        state.buffer = "";
        return;
      }
      if (stat.size === state.position) return;

      const handle = await fsp.open(state.rolloutPath, "r");
      try {
        const length = stat.size - state.position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, state.position);
        state.position = stat.size;
        await this.processChunk(state, buffer.toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      process.stderr.write(`Rollout mirror error for ${state.rolloutPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      state.reading = false;
    }
  }

  private async processChunk(state: MirrorState, chunk: string): Promise<void> {
    state.buffer += chunk;
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const parsed = parseRolloutLine(state.threadId, line);
      if (parsed.complete) {
        await state.onComplete({ threadId: state.threadId, ...parsed.complete });
      }
      if (parsed.approval) {
        const key = `${parsed.approval.turnId ?? ""}:${parsed.approval.message}`;
        if (!state.seenApprovals.has(key)) {
          state.seenApprovals.add(key);
          await state.onApproval({ threadId: state.threadId, ...parsed.approval });
        }
      }
    }
  }
}

function parseRolloutLine(threadId: string, line: string): ParsedRolloutEvent {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.type !== "event_msg" || !isRecord(parsed.payload)) return {};

  const payload = parsed.payload;
  if (payload.type === "task_complete" && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
    return {
      complete: {
        turnId: typeof payload.turn_id === "string" ? payload.turn_id : undefined,
        finalMessage: payload.last_agent_message,
      },
    };
  }

  const approval = approvalNoticeFromPayload(threadId, payload);
  return approval ? { approval } : {};
}

function approvalNoticeFromPayload(
  _threadId: string,
  payload: Record<string, unknown>,
): Omit<MirroredApprovalNotice, "threadId"> | undefined {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (!/approval|elicitation|permission/i.test(type) || /approved|denied|completed/i.test(type)) return undefined;

  const command = Array.isArray(payload.command)
    ? payload.command.filter((part): part is string => typeof part === "string").join(" ")
    : typeof payload.command === "string"
      ? payload.command
      : undefined;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;

  const lines = [
    "Terminal-owned Codex turn appears to be waiting for approval.",
    reason,
    cwd ? `cwd: \`${cwd}\`` : undefined,
    command ? `command: \`${command}\`` : undefined,
    "Approve or deny it in the terminal; the bridge will mirror the final answer when the turn completes.",
  ];

  return {
    turnId: typeof payload.turn_id === "string" ? payload.turn_id : undefined,
    message: lines.filter(Boolean).join("\n"),
  };
}
