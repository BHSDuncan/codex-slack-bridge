import { describe, expect, it } from "vitest";
import { formatApprovalMessage, summarizeApproval } from "../src/codex/approvalText.js";

describe("approval text", () => {
  it("uses Codex's reason when provided", () => {
    expect(
      summarizeApproval({
        id: 1,
        method: "item/commandExecution/requestApproval",
        command: ["npm", "install"],
        reason: "Install dependencies",
        raw: {},
      }),
    ).toBe("Install dependencies");
  });

  it("includes command and cwd in Slack prompt text", () => {
    const text = formatApprovalMessage({
      id: 1,
      method: "item/commandExecution/requestApproval",
      command: ["codex", "app-server"],
      cwd: "/repo",
      raw: {},
    });
    expect(text).toContain("Codex needs approval");
    expect(text).toContain("local app-server");
    expect(text).toContain("`/repo`");
    expect(text).toContain("`codex app-server`");
  });
});
