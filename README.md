# Codex Slack Bridge

Local Slack UI for Codex sessions on this machine.

## Current shape

- One private Slack control channel.
- One Slack thread per Codex session.
- Only the configured Slack user and configured channels/DMs can use the bridge.
- The bridge is disabled by default unless `BRIDGE_ENABLED_ON_START=true`.
- Normal progress is suppressed. Final turn output is posted to Slack.
- Required Codex approval or elicitation requests are forwarded to Slack immediately.
- Codex app-server is the primary adapter. `codex exec/resume` is available as a fallback adapter.

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
| `BRIDGE_ENABLED_ON_START` | No | Set to `true` to allow Slack control immediately when the daemon starts. Default is `false`, so you must run `/codex enable`. |
| `BRIDGE_APPROVAL_POLICY` | No | Codex approval policy for turns started by the bridge. Supported values are `on-request`, `untrusted`, and `never`; default is `on-request`. |
| `BRIDGE_CODEX_MODEL` | No | Optional Codex model override for bridge-created turns. Leave unset to use your Codex config default. |
| `BRIDGE_CODEX_PROFILE` | No | Optional Codex profile name for the fallback `codex exec` adapter. The app-server adapter currently uses direct config fields instead of profiles. |

## Slack commands

- `/codex enable`
- `/codex disable`
- `/codex status`
- `/codex list`
- `/codex new <prompt>`
- `/codex resume <session-id-or-name> [prompt]`
- `/codex attach <session-id-or-name>`

After `new`, `resume`, or `attach`, reply in the created Slack thread to continue that Codex session.
