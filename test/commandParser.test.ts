import { describe, expect, it } from "vitest";
import { parseCodexCommand, splitFirstArg } from "../src/slack/commandParser.js";

describe("command parser", () => {
  it("defaults to help for an empty command", () => {
    expect(parseCodexCommand("   ")).toEqual({ name: "help", args: "" });
  });

  it("splits command name from args", () => {
    expect(parseCodexCommand("resume abc123 please continue")).toEqual({
      name: "resume",
      args: "abc123 please continue",
    });
  });

  it("splits the first arg from the remaining prompt", () => {
    expect(splitFirstArg("abc123 please continue")).toEqual({ first: "abc123", rest: "please continue" });
    expect(splitFirstArg("")).toEqual({ rest: "" });
  });
});
