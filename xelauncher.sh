#!/bin/bash
# ============================================================
#  xelauncher.sh  — Script wrapper XeLauncher
#  À placer dans ~/xelauncher/xelauncher.sh
#  À appeler depuis autostart / .bashrc / systemd à la place
#  d'appeler directement "electron main.js"
#
#  Fonctionnement :
#    1. Lance Electron (XeLauncher)
#    2. Quand Electron se ferme, vérifie /tmp/xelauncher-launch-next
#    3. Si le fichier existe → exécute la commande dedans (RetroPie / Jellyfin)
#    4. Dès que la commande se termine → retour à l'étape 1
#    5. Si le fichier n'existe pas → arrêt définitif du launcher
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_FILE="/tmp/xelauncher-launch-next"

# Chemin vers electron — adapter si besoin
ELECTRON_BIN="$(which electron 2>/dev/null || which electron12 2>/dev/null || echo electron)"

# Main entry point
MAIN_JS="$SCRIPT_DIR/src/main.js"
if [ ! -f "$MAIN_JS" ]; then
  MAIN_JS="$SCRIPT_DIR/main.js"
fi

log() {
  echo "[xelauncher.sh] $*" | tee -a "$SCRIPT_DIR/xelauncher.log"
}

log "Démarrage — electron: $ELECTRON_BIN — main: $MAIN_JS"

while true; do
  # Nettoyer le fichier de lancement
  rm -f "$LAUNCH_FILE"

  # Lancer Electron (bloquant jusqu'à la fermeture)
  log "Lancement Electron..."
  "$ELECTRON_BIN" "$MAIN_JS" --no-sandbox 2>>"$SCRIPT_DIR/electron.log"
  EXIT_CODE=$?
  log "Electron terminé (code $EXIT_CODE)"

  # Vérifier si une application externe doit être lancée
  if [ -f "$LAUNCH_FILE" ]; then
    CMD=$(cat "$LAUNCH_FILE")
    rm -f "$LAUNCH_FILE"
    log "Lancement externe: $CMD"
    eval "$CMD"
    log "Application externe terminée, retour au launcher"
    # Petite pause pour laisser X11 / GPU se réinitialiser
    sleep 1
  else
    # Pas de fichier → sortie voulue (reboot / poweroff / etc.)
    log "Arrêt propre du launcher"
    break
  fi
done

log "xelauncher.sh terminé"
