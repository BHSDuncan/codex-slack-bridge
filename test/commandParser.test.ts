import { describe, expect, it } from "vitest";
import { parseCodexCommand, parsePositiveOrdinal, splitFirstArg } from "../src/slack/commandParser.js";

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

  it("parses positive ordinals only", () => {
    expect(parsePositiveOrdinal("1")).toBe(1);
    expect(parsePositiveOrdinal("12")).toBe(12);
    expect(parsePositiveOrdinal("0")).toBeUndefined();
    expect(parsePositiveOrdinal("1a")).toBeUndefined();
    expect(parsePositiveOrdinal("01")).toBeUndefined();
  });
});
