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
