import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexSessionSummary } from "../types.js";

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
}

interface RolloutSession extends CodexSessionSummary {
  path: string;
}

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function listCodexSessions(codexHome = path.join(os.homedir(), ".codex")): Promise<CodexSessionSummary[]> {
  const indexed = await readSessionIndex(path.join(codexHome, "session_index.jsonl"));
  const discovered = await discoverRolloutSessions([
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ]);

  const byId = new Map<string, CodexSessionSummary>();
  for (const session of indexed) byId.set(session.id, session);
  for (const session of discovered) {
    const existing = byId.get(session.id);
    byId.set(session.id, {
      ...session,
      threadName: existing?.threadName ?? session.threadName,
      updatedAt: maxIso(existing?.updatedAt, session.updatedAt),
    });
  }

  return [...byId.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function readSessionIndex(indexPath: string): Promise<CodexSessionSummary[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
        return {
          id: parsed.id ?? "",
          threadName: parsed.thread_name,
          updatedAt: parsed.updated_at,
        };
      } catch {
        return { id: "" };
      }
    })
    .filter((session) => session.id)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function discoverRolloutSessions(roots: string[]): Promise<RolloutSession[]> {
  const files = (await Promise.all(roots.map(findRolloutFiles))).flat();
  return (await Promise.all(files.map(readRolloutSession))).filter((session): session is RolloutSession => !!session);
}

async function findRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }),
    );
  }
  await visit(root);
  return files;
}

async function readRolloutSession(filePath: string): Promise<RolloutSession | undefined> {
  const idFromPath = filePath.match(SESSION_ID_PATTERN)?.[1];
  let raw: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
  } catch {
    return idFromPath ? { id: idFromPath, path: filePath } : undefined;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const meta = parseSessionMeta(lines);
  const id = meta?.id ?? idFromPath;
  if (!id) return undefined;

  return {
    id,
    threadName: firstUserMessageTitle(lines) ?? (meta?.cwd ? path.basename(meta.cwd) : undefined),
    updatedAt: lastTimestamp(lines) ?? new Date(stat.mtimeMs).toISOString(),
    cwd: meta?.cwd,
    path: filePath,
  };
}

function parseSessionMeta(lines: string[]): SessionMetaPayload | undefined {
  for (const line of lines.slice(0, 20)) {
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: SessionMetaPayload };
      if (parsed.type === "session_meta") return parsed.payload;
    } catch {
      continue;
    }
  }
  return undefined;
}

function firstUserMessageTitle(lines: string[]): string | undefined {
  for (const line of lines.slice(0, 200)) {
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: { type?: string; message?: string } };
      const message = parsed.type === "event_msg" && parsed.payload?.type === "user_message" ? parsed.payload.message : undefined;
      if (message) return summarizeTitle(message);
    } catch {
      continue;
    }
  }
  return undefined;
}

function lastTimestamp(lines: string[]): string | undefined {
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      if (parsed.timestamp) return parsed.timestamp;
    } catch {
      continue;
    }
  }
  return undefined;
}

function summarizeTitle(message: string): string {
  const firstLine = message
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = (firstLine ?? message).replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

export async function resolveCodexSession(input: string, codexHome?: string): Promise<CodexSessionSummary | undefined> {
  const sessions = await listCodexSessions(codexHome);
  const exact = sessions.find((session) => session.id === input || session.threadName === input);
  if (exact) return exact;
  const lower = input.toLowerCase();
  const matches = sessions.filter((session) => session.threadName?.toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : undefined;
}
