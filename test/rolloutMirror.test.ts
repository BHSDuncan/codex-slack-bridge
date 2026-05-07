import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RolloutMirror } from "../src/codex/rolloutMirror.js";
import type { MirroredApprovalNotice, MirroredTurnComplete } from "../src/types.js";

describe("RolloutMirror", () => {
  it("parses terminal-owned task completion messages", async () => {
    const mirror = new RolloutMirror();
    const parsed = await mirror.handleLineForTest(
      "thread-1",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "Terminal final answer",
        },
      }),
    );

    expect(parsed.complete).toEqual({
      turnId: "turn-1",
      finalMessage: "Terminal final answer",
    });
  });

  it("tracks the prompt that belongs to an appended terminal-owned turn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-mirror-"));
    const rolloutPath = path.join(dir, "rollout.jsonl");
    await fs.writeFile(rolloutPath, "", "utf8");

    const mirror = new RolloutMirror(25);
    const completions: MirroredTurnComplete[] = [];
    await mirror.watch(
      "thread-1",
      rolloutPath,
      async (event) => {
        completions.push(event);
      },
      async () => {},
    );

    await fs.appendFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "What did I ask you to do?",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
            last_agent_message: "You asked me to explain the task.",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await waitFor(() => completions.length === 1);
    await mirror.stop();

    expect(completions).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        prompt: "What did I ask you to do?",
        finalMessage: "You asked me to explain the task.",
      },
    ]);
  });

  it("seeds an in-flight turn prompt from existing rollout lines without replaying completed turns", async () => {
    const mirror = new RolloutMirror();
    const seeded = await mirror.seedFromLinesForTest([
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "old-turn" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "Old prompt" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "old-turn", last_agent_message: "Old answer" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "active-turn" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "Active prompt" },
      }),
    ]);

    expect(seeded).toEqual({
      activeTurnId: "active-turn",
      promptsByTurnId: { "active-turn": "Active prompt" },
    });
  });

  it("uses a seeded prompt when an already-running turn completes after attach", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-mirror-"));
    const rolloutPath = path.join(dir, "rollout.jsonl");
    await fs.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started", turn_id: "active-turn" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Already running prompt" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const mirror = new RolloutMirror(25);
    const completions: MirroredTurnComplete[] = [];
    await mirror.watch(
      "thread-1",
      rolloutPath,
      async (event) => {
        completions.push(event);
      },
      async () => {},
    );

    await fs.appendFile(
      rolloutPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "active-turn",
          last_agent_message: "Already running answer",
        },
      })}\n`,
      "utf8",
    );

    await waitFor(() => completions.length === 1);
    await mirror.stop();

    expect(completions).toEqual([
      {
        threadId: "thread-1",
        turnId: "active-turn",
        prompt: "Already running prompt",
        finalMessage: "Already running answer",
      },
    ]);
  });

  it("parses terminal approval notices as notifications only", async () => {
    const mirror = new RolloutMirror();
    const parsed = await mirror.handleLineForTest(
      "thread-1",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "exec_approval_request",
          turn_id: "turn-1",
          cwd: "/repo",
          command: ["npm", "install"],
          reason: "Install dependencies",
        },
      }),
    );

    expect(parsed.approval?.message).toContain("waiting for approval");
    expect(parsed.approval?.message).toContain("Install dependencies");
    expect(parsed.approval?.message).toContain("`/repo`");
    expect(parsed.approval?.message).toContain("`npm install`");
  });

  it("parses terminal agent questions as input notifications", async () => {
    const mirror = new RolloutMirror();
    const parsed = await mirror.handleLineForTest(
      "thread-1",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          turn_id: "turn-1",
          message: "Which deployment target should I use?",
        },
      }),
    );

    expect(parsed.approval?.turnId).toBe("turn-1");
    expect(parsed.approval?.message).toContain("waiting for your input");
    expect(parsed.approval?.message).toContain("Which deployment target should I use?");
    expect(parsed.approval?.message).toContain("Reply in this Slack thread");
  });

  it("ignores non-question terminal agent messages while mirroring", async () => {
    const mirror = new RolloutMirror();
    const parsed = await mirror.handleLineForTest(
      "thread-1",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          turn_id: "turn-1",
          message: "I am checking the test output now.",
        },
      }),
    );

    expect(parsed.approval).toBeUndefined();
  });

  it("watches only lines appended after attach time", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-mirror-"));
    const rolloutPath = path.join(dir, "rollout.jsonl");
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old-turn",
          last_agent_message: "old answer",
        },
      })}\n`,
      "utf8",
    );

    const mirror = new RolloutMirror(25);
    const completions: MirroredTurnComplete[] = [];
    const approvals: MirroredApprovalNotice[] = [];
    await mirror.watch(
      "thread-1",
      rolloutPath,
      async (event) => {
        completions.push(event);
      },
      async (event) => {
        approvals.push(event);
      },
    );

    await fs.appendFile(
      rolloutPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "new-turn",
          last_agent_message: "new answer",
        },
      })}\n`,
      "utf8",
    );

    await waitFor(() => completions.length === 1);
    await mirror.stop();

    expect(completions).toEqual([{ threadId: "thread-1", turnId: "new-turn", finalMessage: "new answer" }]);
    expect(approvals).toEqual([]);
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
