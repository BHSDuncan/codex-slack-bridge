import path from "node:path";
import dotenv from "dotenv";
import type { ApprovalPolicy, BridgeConfig } from "./types.js";

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseApprovalPolicy(value: string | undefined): ApprovalPolicy {
  const policy = (value ?? "on-request").trim();
  if (policy === "untrusted" || policy === "on-request" || policy === "never") {
    return policy;
  }
  throw new Error(`Unsupported BRIDGE_APPROVAL_POLICY: ${policy}`);
}

export function loadConfig(): BridgeConfig {
  const dataDir = optional("BRIDGE_DATA_DIR") ?? ".bridge-data";
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackSigningSecret: optional("SLACK_SIGNING_SECRET"),
    allowedUserId: required("BRIDGE_ALLOWED_USER_ID"),
    allowedChannelIds: new Set(
      required("BRIDGE_ALLOWED_CHANNEL_IDS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    codexBin: optional("BRIDGE_CODEX_BIN") ?? "codex",
    defaultCwd: optional("BRIDGE_DEFAULT_CWD") ?? process.cwd(),
    dataDir: path.resolve(dataDir),
    enabledOnStart: parseBoolean(process.env.BRIDGE_ENABLED_ON_START, false),
    approvalPolicy: parseApprovalPolicy(process.env.BRIDGE_APPROVAL_POLICY),
    model: optional("BRIDGE_CODEX_MODEL"),
    profile: optional("BRIDGE_CODEX_PROFILE"),
  };
}
