# Codex Slack Bridge

Local Slack UI for Codex sessions on this machine.

## Current shape

- One private Slack control channel.
- One Slack thread per Codex session.
- Only the configured Slack user and configured channels/DMs can use the bridge.
- The bridge is disabled by default unless `BRIDGE_ENABLED_ON_START=true`.
- Normal progress is suppressed. Final turn output is posted to Slack.
- Required Codex approval requests are forwarded to Slack immediately.
- Interactive Codex elicitation requests are rejected with a visible Slack notice instead of being answered silently.
- Codex app-server is the runtime adapter.
- Attached terminal-started sessions mirror future terminal-owned final answers from Codex rollout files.

OpenClaw is intentionally not used in v1. Direct Codex CLI/app-server integration gives tighter control over local sessions, approvals, and Slack authorization with fewer moving parts.

## Setup

1. Use Node 20 or newer.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in Slack tokens and allowlists.
4. In Slack, configure Socket Mode and a slash command named `/codex` pointing at the app.
5. Start the local daemon:

   ```sh
   npm run start
   ```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token from **OAuth & Permissions**. It starts with `xoxb-` and is used to post messages, receive slash commands, and handle message events. |
| `SLACK_APP_TOKEN` | Yes | Slack app-level token from **Basic Information -> App-Level Tokens**. It starts with `xapp-`, needs `connections:write`, and lets the daemon connect through Socket Mode. |
| `SLACK_SIGNING_SECRET` | No for Socket Mode, recommended | Slack signing secret from **Basic Information**. Bolt accepts it even in Socket Mode; keep it set so the same config works if an HTTP receiver is added later. |
| `BRIDGE_ALLOWED_USER_ID` | Yes | The only Slack user ID allowed to control Codex. Use the Slack member ID, such as `U0123456789`, not a display name. |
| `BRIDGE_ALLOWED_CHANNEL_IDS` | Yes | Comma-separated Slack channel or DM IDs where the bridge is allowed to respond, such as `C...`, `G...`, or `D...`. This prevents accidental use from other Slack surfaces. |
| `BRIDGE_DEFAULT_CWD` | Yes | Default local working directory for new or attached Codex sessions. Use the parent directory or repo path where you normally want Codex to start. |
| `BRIDGE_CODEX_BIN` | Yes | Path or command name for the Codex CLI binary. On this machine it is usually `/opt/homebrew/bin/codex`. |
| `BRIDGE_DATA_DIR` | No | Directory for bridge-local state, including Slack-thread-to-Codex-session mappings. Defaults to `.bridge-data` in this repo. |
| `BRIDGE_ENABLED_ON_START` | No | Initial enabled state when no persisted bridge state exists. Default is `false`, so the first run requires `/codex enable`. After that, `/codex enable` and `/codex disable` persist across daemon restarts in `BRIDGE_DATA_DIR`. |
| `BRIDGE_APPROVAL_POLICY` | No | Codex approval policy for turns started by the bridge. Supported values are `on-request`, `untrusted`, and `never`; default is `on-request`. |
| `BRIDGE_USE_CAFFEINATE` | No | Set to `true` only if the LaunchAgent should run the bridge under `caffeinate -dimsu`. Default is `false`; see durability notes below. |
| `BRIDGE_CODEX_MODEL` | No | Optional Codex model override for bridge-created turns. Leave unset to use your Codex config default. |
| `BRIDGE_CODEX_PROFILE` | No | Reserved for future adapter support. The app-server adapter currently uses direct config fields instead of profiles. |

## Running with launchd

For daily use on macOS, install the bridge as a user LaunchAgent:

```sh
npm run launchd:install
```

This writes `~/Library/LaunchAgents/io.github.codex-slack-bridge.plist`, starts the service for your current login session, and restarts it if it crashes. Logs are written under `.bridge-data/logs/`.

Useful commands:

```sh
npm run launchd:status
npm run launchd:uninstall
```

The LaunchAgent starts the daemon at login. The logical enabled/disabled state is stored in `BRIDGE_DATA_DIR`, so `/codex enable` and `/codex disable` survive daemon restarts. `BRIDGE_ENABLED_ON_START` is only used before that persisted state file exists.

After bridge code changes, restart the LaunchAgent:

```sh
npm run launchd:install
```

That command unloads any existing bridge service, rewrites the plist, bootstraps it, and kickstarts the new process. If dependencies changed, run the full local check first:

```sh
npm install
npm run build
npm test
npm run launchd:install
```

To restart the currently installed service without rewriting the plist:

```sh
launchctl kickstart -k gui/$(id -u)/io.github.codex-slack-bridge
```

To watch logs during restart:

```sh
tail -f .bridge-data/logs/launchd.out.log .bridge-data/logs/launchd.err.log
```

### Caffeinate

`launchd` makes the process restart and reconnect, but it does not make the Mac operate while asleep. If the laptop sleeps, the bridge and local Codex sessions pause and Slack Socket Mode disconnects until wake.

Use `BRIDGE_USE_CAFFEINATE=true` only when you deliberately want the LaunchAgent to prevent idle sleep while the bridge is running. That is useful during live testing or when you expect to step away during a long Codex turn, but it can drain battery and keep the laptop warm. The default is `false`; for occasional use, running this in a separate terminal is often better:

```sh
caffeinate -dimsu
```

## Slack commands

- `/codex enable`
- `/codex disable`
- `/codex status`
- `/codex list`
- `/codex new <prompt>`
- `/codex resume <session-id-or-name> [prompt]`
- `/codex attach <session-id-or-name>`
- `/codex detach <session-id-or-name>`

After `new`, `resume`, or `attach`, reply in the mapped Slack thread to continue that Codex session. A Codex session can have only one active Slack control thread. If you attach a session that is already attached, the bridge reuses the existing Slack thread instead of creating a duplicate.

`/codex list` shows numbered recent sessions and stores that list for your Slack user in the current channel or DM. You can use the numbers with later commands:

```text
/codex attach 1
/codex resume 2 Continue from here and run tests.
```

UUIDs and unique title fragments still work. The first ten list entries also include Slack buttons: **Attach** creates or reuses a Slack thread for that session, and **Start turn...** opens a prompt modal before creating or reusing the thread and starting work.

When `attach` is used on a session that is currently active in the terminal, the bridge watches that session's rollout file and posts future terminal-owned final answers into the Slack thread. The bridge scans the tail of the rollout file at attach time, so mirrored terminal-owned final answers usually include the prompt that kicked off the in-flight turn even if the prompt was recorded before attach. Approval prompts from terminal-owned turns are notification-only; approve or deny those in the terminal. After the terminal-owned turn completes, replying in Slack starts the next turn through the bridge.

Slack does not support slash commands inside threads, so thread-local detach uses the **Detach** button on the Slack control thread or a plain thread reply of `detach` or `codex detach`. Use `/codex detach <session-id-or-number>` from any authorized channel or DM to detach a specific session. Detaching the final mapping for a session also stops its rollout mirror watcher. On startup, the bridge removes older duplicate mappings and keeps the newest Slack thread for each Codex session.
