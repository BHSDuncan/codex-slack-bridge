export class BridgeState {
  private enabled: boolean;

  constructor(enabledOnStart: boolean) {
    this.enabled = enabledOnStart;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }
}
