import fs from "node:fs/promises";
import path from "node:path";
import type { SessionListSnapshot, SessionRecord } from "./types.js";

interface StoreFile {
  sessions: SessionRecord[];
  listSnapshots?: SessionListSnapshot[];
}

export class SessionStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write({ sessions: [], listSnapshots: [] });
    }
  }

  async upsert(record: SessionRecord): Promise<void> {
    const data = await this.read();
    data.listSnapshots ??= [];
    const index = data.sessions.findIndex(
      (candidate) => candidate.slackChannelId === record.slackChannelId && candidate.slackThreadTs === record.slackThreadTs,
    );
    if (index >= 0) {
      data.sessions[index] = record;
    } else {
      data.sessions.push(record);
    }
    await this.write(data);
  }

  async findBySlackThread(slackChannelId: string, slackThreadTs: string): Promise<SessionRecord | undefined> {
    const data = await this.read();
    return data.sessions.find(
      (record) => record.slackChannelId === slackChannelId && record.slackThreadTs === slackThreadTs,
    );
  }

  async findByCodexThread(codexThreadId: string): Promise<SessionRecord | undefined> {
    const data = await this.read();
    return data.sessions.find((record) => record.codexThreadId === codexThreadId);
  }

  async list(): Promise<SessionRecord[]> {
    return (await this.read()).sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveListSnapshot(snapshot: SessionListSnapshot): Promise<void> {
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
  }

  async getListSnapshot(slackUserId: string, slackChannelId: string): Promise<SessionListSnapshot | undefined> {
    const data = await this.read();
    return data.listSnapshots?.find(
      (snapshot) => snapshot.slackUserId === slackUserId && snapshot.slackChannelId === slackChannelId,
    );
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
