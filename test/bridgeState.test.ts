import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeState } from "../src/bridgeState.js";

describe("BridgeState", () => {
  it("uses the configured startup default when no persisted state exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-state-"));
    expect(new BridgeState(true, dir).isEnabled()).toBe(true);
    expect(new BridgeState(false, dir).isEnabled()).toBe(false);
  });

  it("persists enable and disable across instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-bridge-state-"));
    const state = new BridgeState(false, dir);
    state.enable();

    expect(new BridgeState(false, dir).isEnabled()).toBe(true);

    const reloaded = new BridgeState(true, dir);
    reloaded.disable();

    expect(new BridgeState(true, dir).isEnabled()).toBe(false);
  });
});
