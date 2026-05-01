#!/bin/zsh
set -euo pipefail

LABEL="${BRIDGE_LAUNCHD_LABEL:-io.github.codex-slack-bridge}"

launchctl print "gui/$(id -u)/$LABEL"
