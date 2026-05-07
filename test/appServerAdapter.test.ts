import { describe, expect, it } from "vitest";
import { AppServerCodexAdapter } from "../src/codex/appServerAdapter.js";
import type { BridgeConfig, TurnResult, UserInputRequest } from "../src/types.js";

const config: BridgeConfig = {
  slackBotToken: "xoxb",
  slackAppToken: "xapp",
  allowedUserId: "U1",
  allowedChannelIds: new Set(["C1"]),
  codexBin: "codex",
  defaultCwd: "/tmp",
  dataDir: "/tmp/bridge",
  enabledOnStart: false,
  approvalPolicy: "on-request",
};

describe("AppServerCodexAdapter", () => {
  it("resumes an existing thread before starting a turn after adapter restart", async () => {
    const adapter = new AppServerCodexAdapter(config);
    const requests: Array<{ method: string; params: unknown }> = [];
    Object.assign(adapter as unknown as { start: () => Promise<void>; request: (method: string, params?: unknown) => Promise<unknown> }, {
      start: async () => {},
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return method === "turn/start" ? { turnId: "turn-1" } : null;
      },
    });

    const turn = adapter.runTurn("thread-1", "Continue from Slack", "/repo");
    await waitFor(() => requests.some((request) => request.method === "turn/start"));
    adapter.handleNotificationForTest("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Done.",
      },
    });
    adapter.handleNotificationForTest("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status: "completed",
      },
    });

    await expect(turn).resolves.toEqual({ threadId: "thread-1", finalMessage: "Done." });
    expect(requests.map((request) => request.method)).toEqual(["thread/resume", "turn/start"]);
    expect(requests[0].params).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
  });

  it("uses final agentMessage text from item/completed when turn/completed has no items", async () => {
    const adapter = new AppServerCodexAdapter(config);
    const finals: TurnResult[] = [];
    adapter.onFinalMessage(async (result) => {
      finals.push(result);
    });

    adapter.handleNotificationForTest("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Hello from Codex.",
      },
    });
    adapter.handleNotificationForTest("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status: "completed",
      },
    });

    expect(finals).toEqual([{ threadId: "thread-1", finalMessage: "Hello from Codex." }]);
  });

  it("emits elicitation requests instead of answering with empty input", async () => {
    const adapter = new AppServerCodexAdapter(config);
    const requests: UserInputRequest[] = [];
    adapter.onUserInputRequest(async (request) => {
      requests.push(request);
    });

    await adapter.handleServerRequestForTest({
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        prompt: "Which deployment target should I use?",
      },
    });

    expect(requests).toEqual([
      {
        id: "elicitation-1",
        method: "mcpServer/elicitation/request",
        threadId: "thread-1",
        prompt: "Which deployment target should I use?",
        raw: {
          threadId: "thread-1",
          prompt: "Which deployment target should I use?",
        },
      },
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
