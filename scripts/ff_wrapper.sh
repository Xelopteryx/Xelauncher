#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/xelopteryx/.Xauthority
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

JF_URL='http://100.111.157.87:8097/web/index.html#!/home.html'
JMP_INPUT_SCRIPT="/home/xelopteryx/xelauncher/scripts/xe_jmp_input.py"
JF_MAPPING_FILE="/home/xelopteryx/xelauncher/jfmapping.json"
REMAP_PID=""

echo "[ff_wrapper] Lancement Firefox sur $JF_URL"

# Démarrer le daemon de remapping evdev → xdotool
if command -v python3 >/dev/null && [ -f "$JMP_INPUT_SCRIPT" ]; then
    python3 "$JMP_INPUT_SCRIPT" "$JF_MAPPING_FILE" &
    REMAP_PID=$!
    echo "[ff_wrapper] xe_jmp_input PID=$REMAP_PID"
fi

firefox --kiosk "$JF_URL"

if [ -n "$REMAP_PID" ]; then
    kill "$REMAP_PID" 2>/dev/null
    wait "$REMAP_PID" 2>/dev/null
fi
