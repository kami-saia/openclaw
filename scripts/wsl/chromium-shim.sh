#!/bin/bash
# Chromium Shim for OpenClaw (WSL2 + WSLg Support)
# Usage: Set browser.executablePath in openclaw.json to point to this script.
#
# Features:
# 1. Ensures DISPLAY is set for WSLg visibility.
# 2. Strips --headless args to force UI visibility (Workaround until core supports headless:false).
# 3. Optional debug logging via DEBUG_SHIM=1.

# Default logging to off
LOGfile="/tmp/chromium-shim.log"

log() {
    if [ "${DEBUG_SHIM}" == "1" ]; then
        echo "[$(date)] $@" >> "$LOGfile"
    fi
}

log "RAW ARGS: $@"

# Filter out headless arguments to force UI
NEW_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == "--headless"* ]]; then
        log "  -> Stripping $arg"
        continue
    fi
    NEW_ARGS+=("$arg")
done

log "  -> CLEAN ARGS: ${NEW_ARGS[@]}"

# Force Display if not present (Required for WSLg)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0
    log "  -> Setting DISPLAY=:0"
fi

# Execute Chromium with filtered args + standard sandbox flags for WSL
exec /usr/bin/chromium-browser \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    "${NEW_ARGS[@]}"
