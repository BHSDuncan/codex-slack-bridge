import type { BridgeConfig } from "./types.js";

export interface SlackActor {
  userId?: string;
  channelId?: string;
}

export function isAuthorized(config: BridgeConfig, actor: SlackActor): boolean {
  return actor.userId === config.allowedUserId && !!actor.channelId && config.allowedChannelIds.has(actor.channelId);
}

export function authorizationError(config: BridgeConfig, actor: SlackActor): string | null {
  if (actor.userId !== config.allowedUserId) return "Only the configured Slack user can use this bridge.";
  if (!actor.channelId || !config.allowedChannelIds.has(actor.channelId)) {
    return "This Slack channel or DM is not allowed to use the bridge.";
  }
  return null;
}
