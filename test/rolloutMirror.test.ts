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
