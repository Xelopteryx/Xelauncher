#!/bin/bash
# ============================================================
#  xelauncher.sh  — Script wrapper XeLauncher
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_FILE="/tmp/xelauncher-launch-next"
ELECTRON_BIN="/home/xelopteryx/xelauncher/node_modules/.bin/electron"
MAIN_JS="$SCRIPT_DIR/src/JSs/main.js"

# -- Tous les logs centralisés dans logs/, aux côtés de jd_wrapper.log --
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

log() {
  echo "[xelauncher.sh] $*" | tee -a "$LOG_DIR/xelauncher.log"
}

log "Démarrage — electron: $ELECTRON_BIN — main: $MAIN_JS"

export DISPLAY=:0
export XAUTHORITY="/home/xelopteryx/.Xauthority"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"

# Attend que X11 soit prêt (max 30s)
log "Attente X11..."
for i in $(seq 1 60); do
  if DISPLAY=:0 XAUTHORITY="/home/xelopteryx/.Xauthority" xdpyinfo >/dev/null 2>&1; then
    log "X11 prêt (${i}s)"
    break
  fi
  sleep 0.5
done

# Autorise les connexions locales
DISPLAY=:0 XAUTHORITY="/home/xelopteryx/.Xauthority" xhost +local: >/dev/null 2>&1 \
  && log "xhost +local: OK" \
  || log "xhost +local: ignoré"

# Démarrer xdg-desktop-portal-gtk pour éviter le timeout DBus de 25s au lancement JD
pkill -f xdg-desktop-portal-gtk 2>/dev/null
sleep 0.3
DISPLAY=:0 /usr/libexec/xdg-desktop-portal-gtk &
log "xdg-desktop-portal-gtk démarré"

while true; do
  rm -f "$LAUNCH_FILE"
  log "Lancement Electron..."
  "$ELECTRON_BIN" "$MAIN_JS" \
  --no-sandbox \
  2> >(grep -v "gbm_wrapper\|dma_buf\|Failed to export" >> "$LOG_DIR/electron.log")
  EXIT_CODE=$?
  log "Electron terminé (code $EXIT_CODE)"

  if [ -f "$LAUNCH_FILE" ]; then
    CMD=$(cat "$LAUNCH_FILE")
    rm -f "$LAUNCH_FILE"
    log "Lancement externe: $CMD"
    eval "$CMD"
    log "Application externe terminée, retour au launcher"
    sleep 1
  elif [ $EXIT_CODE -ne 0 ]; then
    # Electron a crashé — attendre 2s et relancer
    log "Electron crashé (code $EXIT_CODE), relance dans 2s..."
    sleep 2
  else
    # Sortie propre sans LAUNCH_FILE = arrêt volontaire
    log "Arrêt propre du launcher"
    break
  fi
done

log "xelauncher.sh terminé"
