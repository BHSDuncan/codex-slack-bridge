import { describe, expect, it } from "vitest";
import { authorizationError, isAuthorized } from "../src/authorization.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  slackBotToken: "xoxb",
  slackAppToken: "xapp",
  allowedUserId: "U1",
  allowedChannelIds: new Set(["C1", "D1"]),
  codexBin: "codex",
  defaultCwd: "/tmp",
  dataDir: "/tmp/bridge",
  enabledOnStart: false,
  approvalPolicy: "on-request",
};

describe("authorization", () => {
  it("allows only the configured user in configured Slack surfaces", () => {
    expect(isAuthorized(config, { userId: "U1", channelId: "C1" })).toBe(true);
    expect(isAuthorized(config, { userId: "U2", channelId: "C1" })).toBe(false);
    expect(isAuthorized(config, { userId: "U1", channelId: "C2" })).toBe(false);
  });

  it("explains rejected users before rejected channels", () => {
    expect(authorizationError(config, { userId: "U2", channelId: "C2" })).toBe("Only the configured Slack user can use this bridge.");
    expect(authorizationError(config, { userId: "U1", channelId: "C2" })).toBe("This Slack channel or DM is not allowed to use the bridge.");
    expect(authorizationError(config, { userId: "U1", channelId: "D1" })).toBeNull();
  });
});
