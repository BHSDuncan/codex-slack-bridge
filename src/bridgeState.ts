import fs from "node:fs";
import path from "node:path";

interface BridgeStateFile {
  enabled?: boolean;
}

export class BridgeState {
  private enabled: boolean;
  private filePath?: string;

  constructor(enabledOnStart: boolean, dataDir?: string) {
    this.filePath = dataDir ? path.join(dataDir, "bridge-state.json") : undefined;
    this.enabled = this.readEnabledState() ?? enabledOnStart;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
    this.writeEnabledState();
  }

  disable(): void {
    this.enabled = false;
    this.writeEnabledState();
  }

  private readEnabledState(): boolean | undefined {
    if (!this.filePath) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as BridgeStateFile;
      return typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
    } catch {
      return undefined;
    }
  }

  private writeEnabledState(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ enabled: this.enabled }, null, 2)}\n`, "utf8");
  }
}
