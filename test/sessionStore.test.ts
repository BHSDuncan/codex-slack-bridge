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
});
