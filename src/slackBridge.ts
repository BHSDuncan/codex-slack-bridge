import { App, type BlockAction, type KnownBlock } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { authorizationError, isAuthorized } from "./authorization.js";
import { BridgeState } from "./bridgeState.js";
import { formatApprovalMessage } from "./codex/approvalText.js";
import { RolloutMirror } from "./codex/rolloutMirror.js";
import { resolveCodexSession } from "./codex/sessionIndex.js";
import { parseCodexCommand, splitFirstArg } from "./slack/commandParser.js";
import { formatBridgeSessions, formatSessionList, helpText, sessionTitleFromPrompt } from "./slack/format.js";
import { SessionStore } from "./sessionStore.js";
import type { ApprovalRequest, BridgeConfig, CodexAdapter, CodexSessionSummary, SessionRecord, TurnResult } from "./types.js";

type SlackCommand = {
  user_id: string;
  channel_id: string;
  text: string;
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
      if (!this.state.isEnabled()) return;

      const record = await this.store.findBySlackThread(event.channel, event.thread_ts);
      if (!record) return;
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
      await this.store.saveListSnapshot({
        slackUserId: command.user_id,
        slackChannelId: command.channel_id,
        sessions: sessions.slice(0, 20),
        createdAt: now(),
      });
      await respond({ response_type: "ephemeral", text: formatSessionList(sessions) });
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
      const session = await resolveCodexSession(first);
      if (!session) {
        await respond({ response_type: "ephemeral", text: `Could not resolve Codex session: ${first}` });
        return;
      }
      await this.handleAttach(command.channel_id, session, client, parsed.name === "resume" ? rest : "");
      await respond({ response_type: "ephemeral", text: `Attached Codex session \`${session.id}\` to a Slack thread.` });
      return;
    }

    await respond({ response_type: "ephemeral", text: helpText() });
  }

  private async handleNew(channelId: string, prompt: string, client: WebClient): Promise<void> {
    const root = await client.chat.postMessage({
      channel: channelId,
      text: `Codex session: ${sessionTitleFromPrompt(prompt)}`,
    });
    if (!root.ts) throw new Error("Slack did not return a thread timestamp");

    const threadId = this.codex.createEmptyThread
      ? await this.codex.createEmptyThread(this.config.defaultCwd)
      : (await this.codex.createThread(prompt, this.config.defaultCwd)).threadId;

    await this.saveMapping(channelId, root.ts, threadId, sessionTitleFromPrompt(prompt), "app-server");
    if (this.codex.runTurn) {
      void this.codex.runTurn(threadId, prompt, this.config.defaultCwd).catch((error) => this.postError(channelId, root.ts!, error));
    }
  }

  private async handleAttach(
    channelId: string,
    session: CodexSessionSummary,
    client: WebClient,
    prompt: string,
  ): Promise<void> {
    const root = await client.chat.postMessage({
      channel: channelId,
      text: `Codex session attached: ${session.threadName ?? session.id}`,
    });
    if (!root.ts) throw new Error("Slack did not return a thread timestamp");

    const cwd = session.cwd ?? this.config.defaultCwd;
    await this.codex.attachThread(session.id, cwd);
    await this.saveMapping(channelId, root.ts, session.id, session.threadName, "app-server", cwd, session.path);
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
  }

  private async sendPrompt(record: SessionRecord, prompt: string, client: WebClient): Promise<void> {
    try {
      if (this.codex.steerThread) {
        try {
          await this.codex.steerThread(record.codexThreadId, prompt);
          return;
        } catch (error) {
          if (!String(error).includes("No active steerable turn")) throw error;
        }
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

  private async postFinal(result: TurnResult): Promise<void> {
    const record = await this.store.findByCodexThread(result.threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: result.finalMessage,
    });
  }

  private trackBridgeOwnedTurn(threadId: string, turn: Promise<TurnResult>): void {
    this.bridgeOwnedActiveTurns.add(threadId);
    this.bridgeOwnedGraceUntil.delete(threadId);
    void turn.then(
      () => {
        this.bridgeOwnedActiveTurns.delete(threadId);
        this.bridgeOwnedGraceUntil.set(threadId, Date.now() + 30_000);
      },
      () => {
        this.bridgeOwnedActiveTurns.delete(threadId);
        this.bridgeOwnedGraceUntil.set(threadId, Date.now() + 30_000);
      },
    );
  }

  private shouldIgnoreMirroredFinal(threadId: string): boolean {
    if (this.bridgeOwnedActiveTurns.has(threadId)) return true;
    const graceUntil = this.bridgeOwnedGraceUntil.get(threadId);
    if (!graceUntil) return false;
    if (graceUntil >= Date.now()) {
      this.bridgeOwnedGraceUntil.delete(threadId);
      return true;
    }
    this.bridgeOwnedGraceUntil.delete(threadId);
    return false;
  }

  private async postMirroredFinal(result: TurnResult): Promise<void> {
    if (this.shouldIgnoreMirroredFinal(result.threadId)) return;
    await this.postFinal(result);
  }

  private async postMirroredApprovalNotice(threadId: string, message: string): Promise<void> {
    if (this.bridgeOwnedActiveTurns.has(threadId)) return;
    const record = await this.store.findByCodexThread(threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: message,
    });
  }

  private async postApproval(request: ApprovalRequest): Promise<void> {
    if (!request.threadId) return;
    const record = await this.store.findByCodexThread(request.threadId);
    if (!record) return;
    await this.app.client.chat.postMessage({
      channel: record.slackChannelId,
      thread_ts: record.slackThreadTs,
      text: formatApprovalMessage(request),
      blocks: blocksForApproval(request),
    });
  }

  private async postError(channelId: string, threadTs: string, error: unknown): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Codex bridge error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
