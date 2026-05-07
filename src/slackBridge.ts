import { App, type BlockAction, type KnownBlock } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { authorizationError, isAuthorized } from "./authorization.js";
import { BridgeState } from "./bridgeState.js";
import { formatApprovalMessage } from "./codex/approvalText.js";
import { latestCompletedTurnFromRollout, RolloutMirror, type LatestCompletedTurn } from "./codex/rolloutMirror.js";
import { resolveCodexSession } from "./codex/sessionIndex.js";
import { parseCodexCommand, parsePositiveOrdinal, splitFirstArg } from "./slack/commandParser.js";
import { formatBridgeSessions, formatSessionList, helpText, sessionTitleFromPrompt } from "./slack/format.js";
import { SessionStore } from "./sessionStore.js";
import type {
  ApprovalRequest,
  BridgeConfig,
  CodexAdapter,
  CodexSessionSummary,
  SessionRecord,
  TurnResult,
  UserInputRequest,
} from "./types.js";

type SlackCommand = {
  user_id: string;
  channel_id: string;
  text: string;
  thread_ts?: string;
};

function now(): string {
  return new Date().toISOString();
}

function blocksForApproval(request: ApprovalRequest): KnownBlock[] {
  const valueBase = { requestId: request.id };
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "codex_approval:approved",
          value: JSON.stringify({ ...valueBase, decision: "approved" }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Approve for session" },
          action_id: "codex_approval:approved_for_session",
          value: JSON.stringify({ ...valueBase, decision: "approved_for_session" }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: "codex_approval:denied",
          value: JSON.stringify({ ...valueBase, decision: "denied" }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Abort" },
          style: "danger",
          action_id: "codex_approval:abort",
          value: JSON.stringify({ ...valueBase, decision: "abort" }),
        },
      ],
    },
  ];
}

function blocksForControlThread(threadId: string): KnownBlock[] {
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Detach" },
          style: "danger",
          action_id: "codex_thread:detach",
          value: JSON.stringify({ threadId }),
        },
      ],
    },
  ];
}

function blocksForSessionList(sessions: CodexSessionSummary[]): KnownBlock[] {
  return sessions.slice(0, 10).flatMap((session, index) => [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: sessionListLine(session, index),
      },
    } satisfies KnownBlock,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Attach" },
          action_id: "codex_session:attach",
          value: JSON.stringify({ sessionId: session.id }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Start turn..." },
          style: "primary",
          action_id: "codex_session:start_turn",
          value: JSON.stringify({ sessionId: session.id }),
        },
      ],
    } satisfies KnownBlock,
  ]);
}

function sessionListLine(session: CodexSessionSummary, index: number): string {
  const name = session.threadName ? ` - ${session.threadName}` : session.cwd ? ` - ${session.cwd}` : "";
  const updated = session.updatedAt ? ` (${session.updatedAt})` : "";
  return `*${index + 1}.* \`${session.id}\`${name}${updated}`;
}

function formatMirroredFinal(prompt: string, finalMessage: string): string {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return finalMessage;
  return `*Prompt*\n>${normalizedPrompt.replace(/\n/g, "\n>")}\n\n*Final message*\n${finalMessage}`;
}

function formatRecentTurnContext(turn: LatestCompletedTurn): string {
  return `*Most recent completed turn*\n\n*Prompt*\n>${turn.prompt.trim().replace(/\n/g, "\n>")}\n\n*Final message*\n${turn.finalMessage}`;
}

function isThreadDetachMessage(text: string): boolean {
  return /^(?:codex\s+detach|detach)$/i.test(text.trim());
}

function withUserMention(userId: string, text: string): string {
  return `<@${userId}> ${text}`;
}

interface AttachResult {
  attached: boolean;
  threadTs: string;
  permalink?: string;
}

export class SlackBridge {
  private app: App;
  private config: BridgeConfig;
  private store: SessionStore;
  private state: BridgeState;
  private codex: CodexAdapter;
  private rolloutMirror: RolloutMirror;
  private bridgeOwnedActiveTurns = new Set<string>();
  private bridgeOwnedGraceUntil = new Map<string, number>();

  constructor(config: BridgeConfig, store: SessionStore, state: BridgeState, codex: CodexAdapter) {
    this.config = config;
    this.store = store;
    this.state = state;
    this.codex = codex;
    this.rolloutMirror = new RolloutMirror();
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      signingSecret: config.slackSigningSecret ?? "socket-mode-unused",
      socketMode: true,
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  private registerHandlers(): void {
    this.codex.onFinalMessage(async (result) => this.postFinal(result));
    this.codex.onApprovalRequest(async (request) => this.postApproval(request));
    this.codex.onUserInputRequest(async (request) => this.postUserInputUnsupported(request));

    this.app.command("/codex", async ({ command, ack, respond, client }) => {
      await ack();
      const error = authorizationError(this.config, {
        userId: (command as SlackCommand).user_id,
        channelId: (command as SlackCommand).channel_id,
      });
      if (error) {
        await respond({ response_type: "ephemeral", text: error });
        return;
      }
      await this.handleSlashCommand(command as SlackCommand, respond as (message: unknown) => Promise<unknown>, client);
    });

    this.app.message(async ({ message, client }) => {
      const event = message as {
        user?: string;
        channel?: string;
        text?: string;
        subtype?: string;
        ts?: string;
        thread_ts?: string;
        bot_id?: string;
      };
      if (event.subtype || event.bot_id || !event.user || !event.channel || !event.text || !event.thread_ts) return;
      if (!isAuthorized(this.config, { userId: event.user, channelId: event.channel })) return;

      const record = await this.store.findBySlackThread(event.channel, event.thread_ts);
      if (!record) return;
      if (isThreadDetachMessage(event.text)) {
        await this.detachRecord(record);
        await client.chat.postMessage({
          channel: record.slackChannelId,
          thread_ts: record.slackThreadTs,
          text: `Detached Codex session \`${record.codexThreadId}\` from this Slack thread.`,
        });
        return;
      }
      if (!this.state.isEnabled()) return;
      await this.sendPrompt(record, event.text, client);
    });

    this.app.action(/^codex_approval:/, async ({ body, action, ack, client }) => {
      await ack();
      const blockAction = action as unknown as BlockAction & { value?: string };
      const actor = body as { user?: { id?: string }; channel?: { id?: string } };
      if (!isAuthorized(this.config, { userId: actor.user?.id, channelId: actor.channel?.id })) return;
      if (!blockAction.value) return;
      const parsed = JSON.parse(blockAction.value) as {
        requestId: string | number;
        decision: "approved" | "approved_for_session" | "denied" | "abort";
      };
      await this.codex.approve({ requestId: parsed.requestId, decision: parsed.decision });
      if (actor.channel?.id) {
        await client.chat.postMessage({
          channel: actor.channel.id,
          text: `Approval decision sent: \`${parsed.decision}\``,
        });
      }
    });

    this.app.action(/^codex_session:/, async ({ body, action, ack, client }) => {
      await ack();
      const blockAction = action as unknown as BlockAction & { value?: string; action_id?: string };
      const actor = body as { user?: { id?: string }; channel?: { id?: string }; trigger_id?: string };
      if (!isAuthorized(this.config, { userId: actor.user?.id, channelId: actor.channel?.id })) return;
      if (!blockAction.value || !actor.channel?.id) return;
      const parsed = JSON.parse(blockAction.value) as { sessionId: string };
      const session = await resolveCodexSession(parsed.sessionId);
      if (!session) {
        await client.chat.postMessage({
          channel: actor.channel.id,
          text: `Could not resolve Codex session \`${parsed.sessionId}\`.`,
        });
        return;
      }
      if (blockAction.action_id === "codex_session:attach") {
        const result = await this.handleAttach(actor.channel.id, session, client, "");
        if (!result.attached && actor.user?.id) {
          await client.chat.postEphemeral({
            channel: actor.channel.id,
            user: actor.user.id,
            text: `Codex session \`${session.id}\` is already attached${result.permalink ? `: ${result.permalink}` : "."}`,
          });
        }
        return;
      }
      if (blockAction.action_id === "codex_session:start_turn" && actor.trigger_id) {
        await client.views.open({
          trigger_id: actor.trigger_id,
          view: {
            type: "modal",
            callback_id: "codex_start_turn",
            private_metadata: JSON.stringify({ channelId: actor.channel.id, sessionId: session.id }),
            title: { type: "plain_text", text: "Start Codex turn" },
            submit: { type: "plain_text", text: "Start" },
            close: { type: "plain_text", text: "Cancel" },
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: `\`${session.id}\`${session.threadName ? ` - ${session.threadName}` : ""}` },
              },
              {
                type: "input",
                block_id: "prompt",
                label: { type: "plain_text", text: "Prompt" },
                element: {
                  type: "plain_text_input",
                  action_id: "value",
                  multiline: true,
                  min_length: 1,
                },
              },
            ],
          },
        });
      }
    });

    this.app.action(/^codex_thread:/, async ({ body, action, ack, client }) => {
      await ack();
      const blockAction = action as unknown as BlockAction & { value?: string; action_id?: string };
      const actor = body as { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string; thread_ts?: string } };
      if (!isAuthorized(this.config, { userId: actor.user?.id, channelId: actor.channel?.id })) return;
      if (!actor.channel?.id || !actor.user?.id || blockAction.action_id !== "codex_thread:detach") return;
      const threadTs = actor.message?.thread_ts ?? actor.message?.ts;
      if (!threadTs) return;
      const record = await this.store.findBySlackThread(actor.channel.id, threadTs);
      if (!record) {
        await client.chat.postEphemeral({
          channel: actor.channel.id,
          user: actor.user.id,
          text: "This Slack thread is not attached to a Codex session.",
        });
        return;
      }
      await this.detachRecord(record);
      await client.chat.postMessage({
        channel: record.slackChannelId,
        thread_ts: record.slackThreadTs,
        text: `Detached Codex session \`${record.codexThreadId}\` from this Slack thread.`,
      });
    });

    this.app.view("codex_start_turn", async ({ ack, body, view, client }) => {
      const actor = body as { user?: { id?: string } };
      let metadata: { channelId?: string; sessionId?: string };
      try {
        metadata = JSON.parse(view.private_metadata || "{}") as { channelId?: string; sessionId?: string };
      } catch {
        metadata = {};
      }
      const prompt = view.state.values.prompt?.value?.value?.trim();
      const authError = authorizationError(this.config, { userId: actor.user?.id, channelId: metadata.channelId });
      if (authError) {
        await ack({
          response_action: "errors",
          errors: { prompt: authError },
        });
        return;
      }
      if (!prompt) {
        await ack({
          response_action: "errors",
          errors: { prompt: "Enter a prompt to start the turn." },
        });
        return;
      }
      await ack();
      if (!metadata.channelId || !metadata.sessionId) return;
      const session = await resolveCodexSession(metadata.sessionId);
      if (!session) {
        await client.chat.postMessage({
          channel: metadata.channelId,
          text: `Could not resolve Codex session \`${metadata.sessionId}\`.`,
        });
        return;
      }
      const result = await this.handleAttach(metadata.channelId, session, client, prompt);
      if (!result.attached && actor.user?.id) {
        await client.chat.postEphemeral({
          channel: metadata.channelId,
          user: actor.user.id,
          text: `Started the turn in the existing Codex Slack thread${result.permalink ? `: ${result.permalink}` : "."}`,
        });
      }
    });
  }

  private async handleSlashCommand(
    command: SlackCommand,
    respond: (message: unknown) => Promise<unknown>,
    client: WebClient,
  ): Promise<void> {
    const parsed = parseCodexCommand(command.text);
    if (parsed.name === "help") {
      await respond({ response_type: "ephemeral", text: helpText() });
      return;
    }
    if (parsed.name === "enable") {
      this.state.enable();
      await respond({ response_type: "ephemeral", text: "Codex Slack bridge enabled." });
      return;
    }
    if (parsed.name === "disable") {
      this.state.disable();
      await respond({ response_type: "ephemeral", text: "Codex Slack bridge disabled." });
      return;
    }
    if (parsed.name === "status") {
      const mapped = await this.store.list();
      await respond({
        response_type: "ephemeral",
        text: `${this.state.isEnabled() ? "Enabled" : "Disabled"}\n${formatBridgeSessions(mapped)}`,
      });
      return;
    }
    if (parsed.name === "list") {
      const sessions = await this.codex.listSessions();
      const visibleSessions = sessions.slice(0, 20);
      await this.store.saveListSnapshot({
        slackUserId: command.user_id,
        slackChannelId: command.channel_id,
        sessions: visibleSessions,
        createdAt: now(),
      });
      await respond({
        response_type: "ephemeral",
        text: formatSessionList(visibleSessions),
        blocks: visibleSessions.length ? blocksForSessionList(visibleSessions) : undefined,
      });
      return;
    }

    if (parsed.name === "detach") {
      await this.handleDetachCommand(command, parsed.args, respond);
      return;
    }

    if (!this.state.isEnabled()) {
      await respond({ response_type: "ephemeral", text: "Bridge is disabled. Run `/codex enable` first." });
      return;
    }

    if (parsed.name === "new") {
      if (!parsed.args) {
        await respond({ response_type: "ephemeral", text: "Usage: `/codex new <prompt>`" });
        return;
      }
      await this.handleNew(command.channel_id, parsed.args, client);
      await respond({ response_type: "ephemeral", text: "Started a new Codex Slack thread." });
      return;
    }

    if (parsed.name === "resume" || parsed.name === "attach") {
      const { first, rest } = splitFirstArg(parsed.args);
      if (!first) {
        await respond({ response_type: "ephemeral", text: `Usage: \`/codex ${parsed.name} <session-id-or-name> [prompt]\`` });
        return;
      }
      const session = await this.resolveSessionArgument(command.user_id, command.channel_id, first);
      if (!session) {
        await respond({
          response_type: "ephemeral",
          text: `Could not resolve Codex session: ${first}. Use \`/codex list\` first if you want to attach or resume by number.`,
        });
        return;
      }
      const result = await this.handleAttach(command.channel_id, session, client, parsed.name === "resume" ? rest : "");
      await respond({
        response_type: "ephemeral",
        text: result.attached
          ? `Attached Codex session \`${session.id}\` to a Slack thread.`
          : `Codex session \`${session.id}\` is already attached${result.permalink ? `: ${result.permalink}` : "."}`,
      });
      return;
    }

    await respond({ response_type: "ephemeral", text: helpText() });
  }

  private async handleNew(channelId: string, prompt: string, client: WebClient): Promise<void> {
    const root = await client.chat.postMessage({
      channel: channelId,
      text: withUserMention(this.config.allowedUserId, `Codex session: ${sessionTitleFromPrompt(prompt)}`),
      blocks: blocksForControlThread("pending"),
    });
    if (!root.ts) throw new Error("Slack did not return a thread timestamp");

    const threadId = this.codex.createEmptyThread
      ? await this.codex.createEmptyThread(this.config.defaultCwd)
      : (await this.codex.createThread(prompt, this.config.defaultCwd)).threadId;

    await this.saveMapping(channelId, root.ts, threadId, sessionTitleFromPrompt(prompt), "app-server");
    if (this.codex.runTurn) {
      const turn = this.codex.runTurn(threadId, prompt, this.config.defaultCwd);
      this.trackBridgeOwnedTurn(threadId, turn);
      void turn.catch((error) => this.postError(channelId, root.ts!, error));
    }
  }

  private async resolveSessionArgument(
    slackUserId: string,
    slackChannelId: string,
    value: string,
  ): Promise<CodexSessionSummary | undefined> {
    const ordinal = parsePositiveOrdinal(value);
    if (ordinal) {
      const snapshot = await this.store.getListSnapshot(slackUserId, slackChannelId);
      return snapshot?.sessions[ordinal - 1];
    }
    return resolveCodexSession(value);
  }

  private async handleAttach(
    channelId: string,
    session: CodexSessionSummary,
    client: WebClient,
    prompt: string,
  ): Promise<AttachResult> {
    await this.store.cleanupDuplicateCodexMappings();
    const existing = await this.store.findByCodexThread(session.id);
    if (existing) {
      if (prompt) {
        void this.sendPrompt(existing, prompt, client);
      }
      return {
        attached: false,
        threadTs: existing.slackThreadTs,
        permalink: await this.threadPermalink(client, existing),
      };
    }

    const root = await client.chat.postMessage({
      channel: channelId,
      text: withUserMention(this.config.allowedUserId, `Codex session attached: ${session.threadName ?? session.id}`),
      blocks: blocksForControlThread(session.id),
    });
    if (!root.ts) throw new Error("Slack did not return a thread timestamp");

    const cwd = session.cwd ?? this.config.defaultCwd;
    const recentTurn = session.path ? await latestCompletedTurnFromRollout(session.path) : undefined;
    await this.codex.attachThread(session.id, cwd);
    await this.saveMapping(channelId, root.ts, session.id, session.threadName, "app-server", cwd, session.path);
    await this.postRecentTurnContext(channelId, root.ts, recentTurn);
    if (session.path) {
      await this.rolloutMirror.watch(
        session.id,
        session.path,
        async (event) => this.postMirroredFinal(event),
        async (event) => this.postMirroredApprovalNotice(event.threadId, event.message),
      );
    }
    if (prompt) {
      void this.sendPrompt(await this.requiredRecord(channelId, root.ts), prompt, client);
    }
    return { attached: true, threadTs: root.ts, permalink: await this.threadPermalink(client, channelId, root.ts) };
  }

  private async postRecentTurnContext(channelId: string, threadTs: string, recentTurn?: LatestCompletedTurn): Promise<void> {
    if (!recentTurn) return;
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: withUserMention(this.config.allowedUserId, formatRecentTurnContext(recentTurn)),
    });
  }

  private async handleDetachCommand(
    command: SlackCommand,
    args: string,
    respond: (message: unknown) => Promise<unknown>,
  ): Promise<void> {
    const { first } = splitFirstArg(args);
    if (first) {
      const session = await this.resolveSessionArgument(command.user_id, command.channel_id, first);
      if (!session) {
        await respond({
          response_type: "ephemeral",
          text: `Could not resolve Codex session: ${first}. Use \`/codex list\` first if you want to detach by number.`,
        });
        return;
      }
      const removed = await this.store.deleteByCodexThread(session.id);
      await this.rolloutMirror.unwatch(session.id);
      await respond({
        response_type: "ephemeral",
        text:
          removed.length > 0
            ? `Detached Codex session \`${session.id}\` from ${removed.length} Slack thread${removed.length === 1 ? "" : "s"}.`
            : `Codex session \`${session.id}\` was not attached.`,
      });
      return;
    }

    if (!command.thread_ts) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: run `/codex detach` in a mapped Slack thread, or use `/codex detach <session-id-or-number>`.",
      });
      return;
    }

    const removed = await this.store.findBySlackThread(command.channel_id, command.thread_ts);
    if (!removed) {
      await respond({ response_type: "ephemeral", text: "This Slack thread is not attached to a Codex session." });
      return;
    }
    await this.detachRecord(removed);
    await respond({ response_type: "ephemeral", text: `Detached Codex session \`${removed.codexThreadId}\` from this Slack thread.` });
  }

  private async detachRecord(record: SessionRecord): Promise<void> {
    await this.store.deleteBySlackThread(record.slackChannelId, record.slackThreadTs);
    const remaining = await this.store.findAllByCodexThread(record.codexThreadId);
    if (remaining.length === 0) {
      await this.rolloutMirror.unwatch(record.codexThreadId);
    }
  }

  private async sendPrompt(record: SessionRecord, prompt: string, client: WebClient): Promise<void> {
    try {
      if (this.codex.steerThread) {
        this.markBridgeOwnedTurnStarted(record.codexThreadId);
        try {
          await this.codex.steerThread(record.codexThreadId, prompt);
          return;
        } catch (error) {
          this.markBridgeOwnedTurnCompleted(record.codexThreadId);
          if (!String(error).includes("No active steerable turn")) throw error;
        }
      }
      if (this.bridgeOwnedActiveTurns.has(record.codexThreadId)) {
        await client.chat.postMessage({
          channel: record.slackChannelId,
          thread_ts: record.slackThreadTs,
          text: "A Codex turn is already running for this Slack thread. Wait for it to finish before starting another turn.",
        });
        return;
      }
      if (this.codex.runTurn) {
        const turn = this.codex.runTurn(record.codexThreadId, prompt, record.cwd);
        this.trackBridgeOwnedTurn(record.codexThreadId, turn);
        void turn.catch((error) => this.postError(record.slackChannelId, record.slackThreadTs, error));
      } else {
        const result = await this.codex.resumeThread(record.codexThreadId, prompt, record.cwd);
        await this.postFinal(result);
      }
    } catch (error) {
      await client.chat.postMessage({
        channel: record.slackChannelId,
        thread_ts: record.slackThreadTs,
        text: `Codex bridge error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async saveMapping(
    slackChannelId: string,
    slackThreadTs: string,
    codexThreadId: string,
    title: string | undefined,
    liveMode: SessionRecord["liveMode"],
    cwd = this.config.defaultCwd,
    rolloutPath?: string,
  ): Promise<void> {
    const timestamp = now();
    await this.store.upsert({
      slackChannelId,
      slackThreadTs,
      codexThreadId,
      title,
      cwd,
      rolloutPath,
      liveMode,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private async requiredRecord(channelId: string, threadTs: string): Promise<SessionRecord> {
    const record = await this.store.findBySlackThread(channelId, threadTs);
    if (!record) throw new Error("Expected Slack thread mapping to exist");
    return record;
  }

  private async postFinal(result: TurnResult, bridgeOwned = true): Promise<void> {
    const record = await this.store.findByCodexThread(result.threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: withUserMention(this.config.allowedUserId, result.finalMessage),
    });
    if (bridgeOwned) this.markBridgeOwnedTurnCompleted(result.threadId);
  }

  private trackBridgeOwnedTurn(threadId: string, turn: Promise<TurnResult>): void {
    this.markBridgeOwnedTurnStarted(threadId);
    void turn.then(
      () => {
        this.markBridgeOwnedTurnCompleted(threadId);
      },
      () => {
        this.markBridgeOwnedTurnCompleted(threadId);
      },
    );
  }

  private markBridgeOwnedTurnStarted(threadId: string): void {
    this.bridgeOwnedActiveTurns.add(threadId);
    this.bridgeOwnedGraceUntil.delete(threadId);
  }

  private markBridgeOwnedTurnCompleted(threadId: string): void {
    this.bridgeOwnedActiveTurns.delete(threadId);
    this.bridgeOwnedGraceUntil.set(threadId, Date.now() + 30_000);
  }

  private shouldIgnoreMirroredEvent(threadId: string): boolean {
    if (this.bridgeOwnedActiveTurns.has(threadId)) return true;
    const graceUntil = this.bridgeOwnedGraceUntil.get(threadId);
    if (!graceUntil) return false;
    if (graceUntil >= Date.now()) {
      return true;
    }
    this.bridgeOwnedGraceUntil.delete(threadId);
    return false;
  }

  private async postMirroredFinal(result: TurnResult): Promise<void> {
    if (this.shouldIgnoreMirroredEvent(result.threadId)) return;
    await this.postFinal(
      {
        ...result,
        finalMessage: "prompt" in result && typeof result.prompt === "string" ? formatMirroredFinal(result.prompt, result.finalMessage) : result.finalMessage,
      },
      false,
    );
  }

  private async postMirroredApprovalNotice(threadId: string, message: string): Promise<void> {
    if (this.shouldIgnoreMirroredEvent(threadId)) return;
    const record = await this.store.findByCodexThread(threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: withUserMention(this.config.allowedUserId, message),
    });
  }

  private async threadPermalink(client: WebClient, record: SessionRecord): Promise<string | undefined>;
  private async threadPermalink(client: WebClient, channelId: string, threadTs: string): Promise<string | undefined>;
  private async threadPermalink(
    client: WebClient,
    recordOrChannelId: SessionRecord | string,
    maybeThreadTs?: string,
  ): Promise<string | undefined> {
    const channel = typeof recordOrChannelId === "string" ? recordOrChannelId : recordOrChannelId.slackChannelId;
    const messageTs = typeof recordOrChannelId === "string" ? maybeThreadTs : recordOrChannelId.slackThreadTs;
    if (!messageTs) return undefined;
    try {
      const response = await client.chat.getPermalink({ channel, message_ts: messageTs });
      return response.permalink;
    } catch {
      return undefined;
    }
  }

  private async postApproval(request: ApprovalRequest): Promise<void> {
    if (!request.threadId) return;
    const record = await this.store.findByCodexThread(request.threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: withUserMention(this.config.allowedUserId, formatApprovalMessage(request)),
      blocks: blocksForApproval(request),
    });
  }

  private async postUserInputUnsupported(request: UserInputRequest): Promise<void> {
    const message = [
      "*Codex requested interactive input*",
      request.prompt,
      "The Slack bridge cannot answer elicitation prompts yet, so this request was rejected instead of sending an empty answer.",
      "Continue the session locally or restate the task with all required details in your next Slack reply.",
    ]
      .filter(Boolean)
      .join("\n");

    if (!request.threadId) {
      process.stderr.write(`${message}\n`);
      return;
    }
    const record = await this.store.findByCodexThread(request.threadId);
    if (!record) {
      process.stderr.write(`${message}\n`);
      return;
    }
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: withUserMention(this.config.allowedUserId, message),
    });
  }

  private async postError(channelId: string, threadTs: string, error: unknown): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: withUserMention(this.config.allowedUserId, `Codex bridge error: ${error instanceof Error ? error.message : String(error)}`),
    });
  }
}
