export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface BridgeConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret?: string;
  allowedUserId: string;
  allowedChannelIds: Set<string>;
  codexBin: string;
  defaultCwd: string;
  dataDir: string;
  enabledOnStart: boolean;
  approvalPolicy: ApprovalPolicy;
  model?: string;
  profile?: string;
}

export interface SessionRecord {
  slackChannelId: string;
  slackThreadTs: string;
  codexThreadId: string;
  title?: string;
  cwd?: string;
  rolloutPath?: string;
  liveMode: "app-server" | "exec" | "pty";
  createdAt: string;
  updatedAt: string;
}

export interface MirroredTurnComplete {
  threadId: string;
  turnId?: string;
  prompt?: string;
  finalMessage: string;
}

export interface MirroredApprovalNotice {
  threadId: string;
  turnId?: string;
  message: string;
}

export interface SessionListSnapshot {
  slackUserId: string;
  slackChannelId: string;
  sessions: CodexSessionSummary[];
  createdAt: string;
}

export interface CodexSessionSummary {
  id: string;
  threadName?: string;
  updatedAt?: string;
  cwd?: string;
  path?: string;
}

export interface TurnResult {
  threadId: string;
  finalMessage: string;
}

export interface ApprovalRequest {
  id: string | number;
  method: string;
  threadId?: string;
  command?: string[];
  cwd?: string;
  reason?: string | null;
  raw: unknown;
}

export interface UserInputRequest {
  id: string | number;
  method: string;
  threadId?: string;
  prompt?: string;
  raw: unknown;
}

export interface ApprovalDecision {
  requestId: string | number;
  decision: "approved" | "approved_for_session" | "denied" | "abort";
}

export interface CodexAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  createEmptyThread?(cwd?: string): Promise<string>;
  runTurn?(threadId: string, prompt: string, cwd?: string): Promise<TurnResult>;
  steerThread?(threadId: string, prompt: string): Promise<void>;
  createThread(prompt: string, cwd?: string): Promise<TurnResult>;
  resumeThread(threadId: string, prompt: string, cwd?: string): Promise<TurnResult>;
  attachThread(threadId: string, cwd?: string): Promise<void>;
  listSessions(): Promise<CodexSessionSummary[]>;
  approve(decision: ApprovalDecision): Promise<void>;
  onFinalMessage(handler: (result: TurnResult) => Promise<void>): void;
  onApprovalRequest(handler: (request: ApprovalRequest) => Promise<void>): void;
  onUserInputRequest(handler: (request: UserInputRequest) => Promise<void>): void;
}
