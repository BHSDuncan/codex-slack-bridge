import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessionStore.js";

describe("SessionStore", () => {
  it("persists and replaces Slack thread mappings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-"));
    const store = new SessionStore(dir);
    await store.init();
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "100.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "100.1",
      codexThreadId: "codex-2",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(await store.findBySlackThread("C1", "100.1")).toMatchObject({ codexThreadId: "codex-2" });
    expect(await store.findByCodexThread("codex-2")).toMatchObject({ slackThreadTs: "100.1" });
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps one active Slack thread per Codex session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-"));
    const store = new SessionStore(dir);
    await store.init();
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "100.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "200.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(await store.findByCodexThread("codex-1")).toMatchObject({ slackThreadTs: "200.1" });
    expect(await store.findAllByCodexThread("codex-1")).toHaveLength(1);
    expect(await store.findBySlackThread("C1", "100.1")).toBeUndefined();
  });

  it("deletes mappings by Slack thread and Codex thread", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-"));
    const store = new SessionStore(dir);
    await store.init();
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "100.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "200.1",
      codexThreadId: "codex-2",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    await expect(store.deleteBySlackThread("C1", "100.1")).resolves.toMatchObject({ codexThreadId: "codex-1" });
    await expect(store.findByCodexThread("codex-1")).resolves.toBeUndefined();
    await expect(store.deleteByCodexThread("codex-2")).resolves.toHaveLength(1);
    await expect(store.list()).resolves.toHaveLength(0);
  });

  it("cleans duplicate Codex mappings by keeping the newest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-"));
    const store = new SessionStore(dir);
    await store.init();
    await store.upsert({
      slackChannelId: "C1",
      slackThreadTs: "100.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const filePath = path.join(dir, "sessions.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { sessions: unknown[]; listSnapshots: unknown[] };
    raw.sessions.push({
      slackChannelId: "C1",
      slackThreadTs: "200.1",
      codexThreadId: "codex-1",
      liveMode: "app-server",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.cleanupDuplicateCodexMappings()).resolves.toHaveLength(1);
    await expect(store.findByCodexThread("codex-1")).resolves.toMatchObject({ slackThreadTs: "200.1" });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("persists the latest per-user per-channel list snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-"));
    const store = new SessionStore(dir);
    await store.init();

    await store.saveListSnapshot({
      slackUserId: "U1",
      slackChannelId: "C1",
      sessions: [{ id: "first" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.saveListSnapshot({
      slackUserId: "U1",
      slackChannelId: "C1",
      sessions: [{ id: "second" }],
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    await expect(store.getListSnapshot("U1", "C1")).resolves.toMatchObject({
      sessions: [{ id: "second" }],
    });
    await expect(store.getListSnapshot("U2", "C1")).resolves.toBeUndefined();
  });
});
