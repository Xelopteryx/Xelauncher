#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/xelopteryx/.Xauthority
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# -- Capture de toute la sortie (wrapper + JD + script input) --
# Avant ce patch, stdout/stderr de ce script et du flatpak JD
# n'étaient redirigés nulle part une fois lancés depuis .xinitrc :
# aucune trace de crash Qt/QtWebEngine n'était jamais persistée.
JD_LOG="/home/xelopteryx/xelauncher/logs/jd_wrapper.log"
exec > >(tee -a "$JD_LOG") 2>&1
echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') jmp_wrapper démarré (PID $$) ====="

# -- Relever la limite de descripteurs de fichiers --
# Constaté : limite héritée à 24 (probablement systemd-logind/PAM via
# .xinitrc), bien en dessous du défaut système usuel (~1024). JD/QtWebEngine
# épuise ce quota en quelques minutes quand le client web Jellyfin retry des
# fetch échoués en boucle serrée pendant la lecture vidéo (chaque tentative
# fuite un fd côté Chromium). Résultat : "Trop de fichiers ouverts (24)",
# puis crash au prochain repaint/interaction. On relève le plafond pour ce
# process avant de lancer JD ; n'affecte que ce sous-shell et ses enfants.
OLD_NOFILE=$(ulimit -n)
ulimit -n 65536 2>/dev/null || ulimit -n 4096 2>/dev/null
echo "[jd_wrapper] ulimit -n: ${OLD_NOFILE} -> $(ulimit -n)"

# -- Attendre que X11 soit réellement joignable (max 10s) --
# xdg-desktop-portal et xdg-desktop-portal-gtk tournent déjà en
# permanence depuis le boot (systemd user units) : on ne les
# touche plus ici. Les tuer/relancer dans ce sous-shell risquait
# de les faire repartir sans le bon environnement de session
# (XDG_CURRENT_DESKTOP, bus D-Bus), ce qui cassait le rendu des
# sous-menus QtWebEngine.
for i in $(seq 1 20); do
    if DISPLAY=:0 xdpyinfo >/dev/null 2>&1; then
        echo "[jd_wrapper] X11 prêt (tentative $i)"
        break
    fi
    sleep 0.5
done

# Lancer Jellyfin en arrière-plan
JMP_INPUT_SCRIPT="/home/xelopteryx/xelauncher/scripts/xe_jmp_input.py"
JF_MAPPING_FILE="/home/xelopteryx/xelauncher/jfmapping.json"
REMAP_PID=""

MAX_ATTEMPTS=5
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))
    echo "[jd_wrapper] Tentative $ATTEMPT/$MAX_ATTEMPTS..."
    START=$(date +%s)

    # Lancer JD en arrière-plan
    # --remote-debugging-port=9222 : écoute uniquement sur 127.0.0.1 par défaut
    # (jamais exposé sur le réseau/Tailscale). Utilisé uniquement par
    # xe_jmp_input.py en local sur le Pi pour contourner le bug de
    # simulation de clic JS de jellyfin-web sur les <select> natifs
    # (Entrée/Espace n'ouvre pas le dropdown visuellement, voir #128/#253
    # sur jellyfin/jellyfin-desktop : "weird mouse input emulator").
    flatpak run --env=QT_QPA_PLATFORMTHEME= --env=XDG_CURRENT_DESKTOP=GNOME org.jellyfin.JellyfinDesktop --remote-debugging-port=9222 &
    JD_PID=$!

    # Attendre que la fenêtre JD soit visible avant de démarrer le daemon input (max 20s)
    WIN=""
    for i in $(seq 1 40); do
        sleep 0.5
        WIN=$(DISPLAY=:0 xdotool search --class jellyfin 2>/dev/null | tail -1)
        if [ -n "$WIN" ]; then
            echo "[jd_wrapper] Fenêtre JD détectée: $WIN"
            break
        fi
    done

    # Démarrer le daemon de remapping evdev → xdotool
    if command -v python3 >/dev/null && [ -f "$JMP_INPUT_SCRIPT" ]; then
        python3 "$JMP_INPUT_SCRIPT" "$JF_MAPPING_FILE" &
        REMAP_PID=$!
        echo "[jd_wrapper] xe_jmp_input PID=$REMAP_PID"
    fi

    wait $JD_PID
    JD_EXIT=$?
    END=$(date +%s)
    RUNTIME=$((END - START))
    if [ $JD_EXIT -ge 128 ]; then
        SIG=$((JD_EXIT - 128))
        echo "[jd_wrapper] JD terminé après ${RUNTIME}s — TUÉ PAR SIGNAL $SIG (exit=$JD_EXIT)"
    else
        echo "[jd_wrapper] JD terminé après ${RUNTIME}s (exit=$JD_EXIT)"
    fi

    # Arrêter le daemon de remapping entre les tentatives
    if [ -n "$REMAP_PID" ]; then
        kill "$REMAP_PID" 2>/dev/null
        wait "$REMAP_PID" 2>/dev/null
        REMAP_PID=""
    fi

    if [ $RUNTIME -gt 15 ]; then
        echo "[jd_wrapper] Sortie normale"
        break
    fi
    # ATTENTION : si tu fermes Jellyfin volontairement en moins de 15s
    # (ex: test rapide), ce garde-fou anti-crash considère ça comme un
    # échec de démarrage et relance automatiquement une nouvelle
    # tentative. C'est voulu pour détecter les vrais crashs au boot
    # (xcb, display indisponible, etc), mais ça peut surprendre lors
    # de sessions de test très courtes.
    echo "[jd_wrapper] Démarrage trop court (${RUNTIME}s), réessai dans 1s..."
    sleep 1
done

