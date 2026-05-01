import { BridgeState } from "./bridgeState.js";
import { AppServerCodexAdapter } from "./codex/appServerAdapter.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./sessionStore.js";
import { SlackBridge } from "./slackBridge.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SessionStore(config.dataDir);
  await store.init();
  const removedDuplicates = await store.cleanupDuplicateCodexMappings();
  if (removedDuplicates.length > 0) {
    process.stdout.write(`Removed ${removedDuplicates.length} duplicate Codex Slack mapping(s).\n`);
  }

  const state = new BridgeState(config.enabledOnStart);
  const codex = new AppServerCodexAdapter(config);
  const bridge = new SlackBridge(config, store, state, codex);

  await bridge.start();
  process.stdout.write(`Codex Slack bridge started (${state.isEnabled() ? "enabled" : "disabled"}).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
