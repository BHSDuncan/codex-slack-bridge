#!/bin/zsh
set -euo pipefail

LABEL="${BRIDGE_LAUNCHD_LABEL:-com.duncan.codex-slack-bridge}"

launchctl print "gui/$(id -u)/$LABEL"
