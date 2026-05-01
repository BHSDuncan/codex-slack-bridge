import fs from "node:fs/promises";
import path from "node:path";
import type { SessionListSnapshot, SessionRecord } from "./types.js";

interface StoreFile {
  sessions: SessionRecord[];
  listSnapshots?: SessionListSnapshot[];
}

export class SessionStore {
  private filePath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async init(): Promise<void> {
    await this.withLock(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await fs.access(this.filePath);
      } catch {
        await this.write({ sessions: [], listSnapshots: [] });
      }
    });
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.withLock(async () => {
      const data = await this.read();
      data.listSnapshots ??= [];
      data.sessions = data.sessions.filter(
        (candidate) =>
          candidate.codexThreadId !== record.codexThreadId ||
          (candidate.slackChannelId === record.slackChannelId && candidate.slackThreadTs === record.slackThreadTs),
      );
      const index = data.sessions.findIndex(
        (candidate) => candidate.slackChannelId === record.slackChannelId && candidate.slackThreadTs === record.slackThreadTs,
      );
      if (index >= 0) {
        data.sessions[index] = record;
      } else {
        data.sessions.push(record);
      }
      await this.write(data);
    });
  }

  async findBySlackThread(slackChannelId: string, slackThreadTs: string): Promise<SessionRecord | undefined> {
    return this.withLock(async () => {
      const data = await this.read();
      return data.sessions.find(
        (record) => record.slackChannelId === slackChannelId && record.slackThreadTs === slackThreadTs,
      );
    });
  }

  async findByCodexThread(codexThreadId: string): Promise<SessionRecord | undefined> {
    return this.withLock(async () => {
      const data = await this.read();
      return data.sessions.find((record) => record.codexThreadId === codexThreadId);
    });
  }

  async findAllByCodexThread(codexThreadId: string): Promise<SessionRecord[]> {
    return this.withLock(async () => {
      const data = await this.read();
      return data.sessions.filter((record) => record.codexThreadId === codexThreadId);
    });
  }

  async deleteBySlackThread(slackChannelId: string, slackThreadTs: string): Promise<SessionRecord | undefined> {
    return this.withLock(async () => {
      const data = await this.read();
      const index = data.sessions.findIndex(
        (record) => record.slackChannelId === slackChannelId && record.slackThreadTs === slackThreadTs,
      );
      if (index < 0) return undefined;
      const [removed] = data.sessions.splice(index, 1);
      await this.write(data);
      return removed;
    });
  }

  async deleteByCodexThread(codexThreadId: string): Promise<SessionRecord[]> {
    return this.withLock(async () => {
      const data = await this.read();
      const removed = data.sessions.filter((record) => record.codexThreadId === codexThreadId);
      if (removed.length === 0) return [];
      data.sessions = data.sessions.filter((record) => record.codexThreadId !== codexThreadId);
      await this.write(data);
      return removed;
    });
  }

  async cleanupDuplicateCodexMappings(): Promise<SessionRecord[]> {
    return this.withLock(async () => {
      const data = await this.read();
      const byCodexThread = new Map<string, SessionRecord[]>();
      for (const record of data.sessions) {
        const records = byCodexThread.get(record.codexThreadId) ?? [];
        records.push(record);
        byCodexThread.set(record.codexThreadId, records);
      }

      const removed: SessionRecord[] = [];
      const kept = new Set<string>();
      for (const records of byCodexThread.values()) {
        if (records.length === 1) {
          kept.add(mappingKey(records[0]));
          continue;
        }
        const sorted = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        kept.add(mappingKey(sorted[0]));
        removed.push(...sorted.slice(1));
      }

      if (removed.length > 0) {
        data.sessions = data.sessions.filter((record) => kept.has(mappingKey(record)));
        await this.write(data);
      }
      return removed;
    });
  }

  async list(): Promise<SessionRecord[]> {
    return this.withLock(async () => (await this.read()).sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async saveListSnapshot(snapshot: SessionListSnapshot): Promise<void> {
    await this.withLock(async () => {
      const data = await this.read();
      data.listSnapshots ??= [];
      const index = data.listSnapshots.findIndex(
        (candidate) => candidate.slackUserId === snapshot.slackUserId && candidate.slackChannelId === snapshot.slackChannelId,
      );
      if (index >= 0) {
        data.listSnapshots[index] = snapshot;
      } else {
        data.listSnapshots.push(snapshot);
      }
      await this.write(data);
    });
  }

  async getListSnapshot(slackUserId: string, slackChannelId: string): Promise<SessionListSnapshot | undefined> {
    return this.withLock(async () => {
      const data = await this.read();
      return data.listSnapshots?.find(
        (snapshot) => snapshot.slackUserId === slackUserId && snapshot.slackChannelId === slackChannelId,
      );
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.then(operation, operation);
    this.operation = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<StoreFile> {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    parsed.listSnapshots ??= [];
    return parsed;
  }

  private async write(data: StoreFile): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

function mappingKey(record: SessionRecord): string {
  return `${record.slackChannelId}:${record.slackThreadTs}`;
}
