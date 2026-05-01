import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCodexSessions, resolveCodexSession } from "../src/codex/sessionIndex.js";

describe("session index", () => {
  it("merges indexed sessions with rollout files missing from the index", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "30"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({
        id: "019de000-0000-7000-8000-000000000001",
        thread_name: "Indexed session",
        updated_at: "2026-04-30T10:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(
        codexHome,
        "sessions",
        "2026",
        "04",
        "30",
        "rollout-2026-04-30T11-00-00-019de000-0000-7000-8000-000000000002.jsonl",
      ),
      [
        JSON.stringify({
          timestamp: "2026-04-30T11:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019de000-0000-7000-8000-000000000002",
            cwd: "/repo/missing-index",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-30T11:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "This is a rollout-only session that should still appear.",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const sessions = await listCodexSessions(codexHome);

    expect(sessions.map((session) => session.id)).toEqual([
      "019de000-0000-7000-8000-000000000002",
      "019de000-0000-7000-8000-000000000001",
    ]);
    expect(sessions[0]).toMatchObject({
      threadName: "This is a rollout-only session that should still appear.",
      cwd: "/repo/missing-index",
      updatedAt: "2026-04-30T11:01:00.000Z",
    });
  });

  it("can resolve a session by partial title from discovered rollout files", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    const id = "019de000-0000-7000-8000-000000000003";
    await fs.writeFile(
      path.join(codexHome, "sessions", `rollout-2026-04-30T11-00-00-${id}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-04-30T11:00:00.000Z",
          type: "session_meta",
          payload: { id },
        }),
        JSON.stringify({
          timestamp: "2026-04-30T11:01:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Unique bridge attach target" },
        }),
      ].join("\n"),
      "utf8",
    );

    await expect(resolveCodexSession("bridge attach", codexHome)).resolves.toMatchObject({ id });
  });
});
