import { describe, expect, it } from "vitest";
import { extractFinalMessage } from "../src/codex/finalMessage.js";

describe("extractFinalMessage", () => {
  it("finds the last assistant text in nested turn data", () => {
    expect(
      extractFinalMessage({
        items: [
          { role: "user", content: [{ text: "hello" }] },
          { role: "assistant", content: [{ text: "first" }] },
          { item: { role: "assistant", content: [{ text: "final" }] } },
        ],
      }),
    ).toBe("final");
  });

  it("returns a stable fallback when no text is available", () => {
    expect(extractFinalMessage({ items: [] })).toBe("Codex completed the turn without a final text message.");
  });
});
