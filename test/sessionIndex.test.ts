import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCodexSessions, resolveCodexSession, syncDiscoveredCodexSessionsToIndex, upsertCodexSessionIndex } from "../src/codex/sessionIndex.js";

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

  it("upserts sessions into the Codex session index", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({
        id: "019de000-0000-7000-8000-000000000004",
        thread_name: "Old title",
        updated_at: "2026-04-30T10:00:00.000Z",
        extra_field: "preserved",
      })}\n`,
      "utf8",
    );

    await upsertCodexSessionIndex(
      {
        id: "019de000-0000-7000-8000-000000000004",
        threadName: "Updated from Slack",
        updatedAt: "2026-04-30T12:00:00.000Z",
      },
      codexHome,
    );
    await upsertCodexSessionIndex(
      {
        id: "019de000-0000-7000-8000-000000000005",
        threadName: "Inserted from Slack",
        updatedAt: "2026-04-30T13:00:00.000Z",
      },
      codexHome,
    );

    const raw = await fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8");
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toEqual([
      {
        id: "019de000-0000-7000-8000-000000000005",
        thread_name: "Inserted from Slack",
        updated_at: "2026-04-30T13:00:00.000Z",
      },
      {
        id: "019de000-0000-7000-8000-000000000004",
        thread_name: "Updated from Slack",
        updated_at: "2026-04-30T12:00:00.000Z",
        extra_field: "preserved",
      },
    ]);
  });

  it("syncs discovered rollout sessions back to the session index", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    const id = "019de000-0000-7000-8000-000000000006";
    await fs.writeFile(
      path.join(codexHome, "sessions", `rollout-2026-04-30T11-00-00-${id}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-04-30T11:00:00.000Z",
          type: "session_meta",
          payload: { id, cwd: "/repo" },
        }),
        JSON.stringify({
          timestamp: "2026-04-30T11:02:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Discovered title" },
        }),
      ].join("\n"),
      "utf8",
    );

    await syncDiscoveredCodexSessionsToIndex(codexHome);

    const raw = await fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8");
    expect(raw.trim()).toBe(
      JSON.stringify({
        id,
        thread_name: "Discovered title",
        updated_at: "2026-04-30T11:02:00.000Z",
      }),
    );
  });
});
