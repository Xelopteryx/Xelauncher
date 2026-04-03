#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5             |
# |                 Version interactive & automatisée            |
# +--------------------------------------------------------------+

set -euo pipefail

# Variables
readonly REPO_URL="https://github.com/Xelopteryx/Xelauncher.git"
readonly INSTALL_DIR="$HOME/xelauncher"
readonly LOCK_FILE="/var/tmp/xelauncher_install.lock"
readonly LOG_FILE="$HOME/xelauncher_install.log"
readonly RETROPIE_SPLASH_DIR="$HOME/RetroPie/splashscreens"
readonly RETROPIE_SPLASH_LIST="/opt/retropie/configs/all/splashscreen.list"
readonly SUDOERS_FILE="/etc/sudoers.d/xelauncher"

readonly RED='\033[1;31m'
readonly GREEN='\033[1;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly BLUE='\033[1;34m'
readonly RESET='\033[0m'

# Mode non-interactif
AUTO_MODE=""   # "" = interactif, "install" = --i, "uninstall" = --u

# Suivi de ce qui a été réellement fait
ACTIONS_DONE=()

# Logging
log()     { echo -e "${CYAN}→${RESET} $1"; }
ok()      { echo -e "${GREEN}✔${RESET} $1"; }
warn()    { echo -e "${YELLOW}!${RESET} $1"; }
error()   { echo -e "${RED}✖${RESET} $1" >&2; }
done_action() { ACTIONS_DONE+=("$1"); }

section() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo -e "${WHITE}$1${RESET}"
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
}

# Trap d'erreur (activé après le menu)
setup_trap() {
    trap 'error "Erreur fatale à la ligne $LINENO. Voir $LOG_FILE"' ERR
}

# ─────────────────────────────────────────────
#  DÉTECTION DE L'ÉTAT D'INSTALLATION
# ─────────────────────────────────────────────
detect_state() {
    HAS_RETROPIE=0
    HAS_JELLYFIN=0
    HAS_X=0
    HAS_NODE=0
    HAS_TAILSCALE=0
    HAS_REPO=0
    HAS_AUTOLOGIN=0

    command -v emulationstation >/dev/null 2>&1 && HAS_RETROPIE=1
    flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1 && HAS_JELLYFIN=1
    command -v startx >/dev/null 2>&1 && HAS_X=1
    command -v node >/dev/null 2>&1 && {
        local v; v=$(node -v | cut -dv -f2 | cut -d. -f1)
        [[ $v -ge 20 ]] && HAS_NODE=1
    }
    command -v tailscale >/dev/null 2>&1 && HAS_TAILSCALE=1
    [[ -d "$INSTALL_DIR" ]] && HAS_REPO=1
    grep -q "XeLauncher" "$HOME/.bash_profile" 2>/dev/null && HAS_AUTOLOGIN=1

    ANYTHING_INSTALLED=0
    [[ $HAS_RETROPIE -eq 1 || $HAS_JELLYFIN -eq 1 || $HAS_X -eq 1 \
       || $HAS_REPO -eq 1 || $HAS_AUTOLOGIN -eq 1 ]] && ANYTHING_INSTALLED=1
}

print_state() {
    echo ""
    echo -e "${WHITE}État actuel du système :${RESET}"
    local check_yes="${GREEN}✔${RESET}"
    local check_no="${RED}✖${RESET}"

    [[ $HAS_NODE -eq 1 ]]      && echo -e "  $check_yes Node.js 20+"        || echo -e "  $check_no Node.js 20+"
    [[ $HAS_TAILSCALE -eq 1 ]] && echo -e "  $check_yes Tailscale"          || echo -e "  $check_no Tailscale"
    [[ $HAS_JELLYFIN -eq 1 ]]  && echo -e "  $check_yes Jellyfin (flatpak)" || echo -e "  $check_no Jellyfin (flatpak)"
    [[ $HAS_X -eq 1 ]]         && echo -e "  $check_yes Serveur X (xinit)"  || echo -e "  $check_no Serveur X (xinit)"
    [[ $HAS_REPO -eq 1 ]]      && echo -e "  $check_yes Dépôt XeLauncher"   || echo -e "  $check_no Dépôt XeLauncher"
    [[ $HAS_RETROPIE -eq 1 ]]  && echo -e "  $check_yes RetroPie"           || echo -e "  $check_no RetroPie"
    [[ $HAS_AUTOLOGIN -eq 1 ]] && echo -e "  $check_yes Autologin TTY1"     || echo -e "  $check_no Autologin TTY1"
    echo ""
}

# ─────────────────────────────────────────────
#  MENU INTERACTIF
# ─────────────────────────────────────────────
interactive_menu() {
    # Si un mode a été passé en argument, on bypasse le menu
    if [[ -n "$AUTO_MODE" ]]; then
        MODE="$AUTO_MODE"
        detect_state

        echo -e "${WHITE}"
        echo "  +--------------------------------------------------+"
        echo "  |        XeLauncher — Prometheus Entertainment     |"
        echo "  |              Script d'installation               |"
        echo "  +--------------------------------------------------+"
        echo -e "${RESET}"
        print_state

        if [[ "$MODE" == "install" ]]; then
            echo -e "${YELLOW}⚠  Mode automatique :${RESET} Installation en cours..."
        else
            echo -e "${RED}⚠  Mode automatique :${RESET} Désinstallation en cours..."
        fi
        echo ""
        return 0  # ← SORTIE SANS CHOISIR, PERMET DE CONTINUER
    fi

    # Mode interactif normal
    clear
    echo -e "${WHITE}"
    echo "  +--------------------------------------------------+"
    echo "  |        XeLauncher — Prometheus Entertainment     |"
    echo "  |              Script d'installation               |"
    echo "  +--------------------------------------------------+"
    echo -e "${RESET}"

    detect_state
    print_state

    local choice=""

    if [[ $ANYTHING_INSTALLED -eq 0 ]]; then
        echo -e "  ${CYAN}[i]${RESET} Installer XeLauncher (RetroPie, Jellyfin, X, Node...)"
        echo -e "  ${RED}[q]${RESET} Quitter"
        echo ""
        while true; do
            read -rp "  Votre choix : " choice </dev/tty
            case "$choice" in
                i|I) MODE="install"; break ;;
                q|Q) echo "Annulé."; exit 0 ;;
                *) echo "  Tapez 'i' pour installer, ou 'q' pour quitter." ;;
            esac
        done
    else
        echo -e "  ${CYAN}[i]${RESET} Installer ce qui manque & mettre à jour"
        echo -e "  ${RED}[u]${RESET} Désinstaller tout ce qu'XeLauncher a installé"
        echo -e "  ${YELLOW}[q]${RESET} Quitter"
        echo ""
        while true; do
            read -rp "  Votre choix : " choice </dev/tty
            case "$choice" in
                i|I) MODE="install"; break ;;
                u|U) MODE="uninstall"; break ;;
                q|Q) echo "Annulé."; exit 0 ;;
                *) echo "  Tapez 'i', 'u' ou 'q'." ;;
            esac
        done
    fi

    echo ""

    if [[ "$MODE" == "install" ]]; then
        echo -e "${YELLOW}⚠  Attention :${RESET} L'installation peut durer ${WHITE}une heure ou plus${RESET},"
        echo    "   notamment à cause de RetroPie."
        echo    "   Assurez-vous que le Raspberry Pi reste allumé et connecté à Internet."
    else
        echo -e "${RED}⚠  Désinstallation :${RESET} Tout ce qu'XeLauncher a installé sera supprimé."
        echo    "   Cela inclut : le dépôt, l'autologin, le service systemd, les sudoers,"
        echo    "   Jellyfin (flatpak), et RetroPie si installé par ce script."
        echo    "   Node.js et Tailscale seront également désinstallés."
    fi

    echo ""
    local confirm=""
    while true; do
        read -rp "  Confirmer ? (y/n) : " confirm </dev/tty
        case "$confirm" in
            y|Y) break ;;
            n|N) echo "Annulé."; exit 0 ;;
            *) echo "  Tapez 'y' pour confirmer ou 'n' pour annuler." ;;
        esac
    done
    echo ""
}

# ─────────────────────────────────────────────
#  FONCTIONS D'INSTALLATION
# ─────────────────────────────────────────────
check_and_install_packages() {
    local to_install=()
    for pkg in "$@"; do
        if ! dpkg -s "$pkg" &>/dev/null; then
            to_install+=("$pkg")
        fi
    done
    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installation des paquets manquants: ${to_install[*]}"
        sudo apt-get install -y "${to_install[@]}"
        done_action "Paquets système installés : ${to_install[*]}"
    fi
}

install_nodejs() {
    if [[ $HAS_NODE -eq 1 ]]; then
        ok "Node.js $(node -v) déjà installé"
        return 0
    fi
    log "Installation de Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node_setup.sh
    sudo bash /tmp/node_setup.sh
    rm -f /tmp/node_setup.sh
    sudo apt-get install -y nodejs
    ok "Node.js installé : $(node -v)"
    done_action "Node.js $(node -v) installé"
}

install_tailscale() {
    if [[ $HAS_TAILSCALE -eq 1 ]]; then
        ok "Tailscale déjà installé"
        return 0
    fi
    log "Installation de Tailscale"
    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh
    sudo bash /tmp/tailscale_install.sh
    rm -f /tmp/tailscale_install.sh
    sudo systemctl enable --now tailscaled 2>/dev/null || true
    ok "Tailscale installé"
    done_action "Tailscale installé et démarré"
}

install_flatpak_jellyfin() {
    if ! command -v flatpak >/dev/null 2>&1; then
        sudo apt-get install -y flatpak
        done_action "Flatpak installé"
    fi

    sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

    if [[ $HAS_JELLYFIN -eq 0 ]]; then
        log "Installation de Jellyfin Media Player"
        exec >/dev/tty 2>&1
        sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player
        exec > >(tee -a "$LOG_FILE") 2>&1
        ok "Jellyfin Media Player installé"
        done_action "Jellyfin Media Player installé via flatpak"
    else
        log "Mise à jour de Jellyfin Media Player"
        flatpak update -y com.github.iwalton3.jellyfin-media-player 2>/dev/null && \
            done_action "Jellyfin Media Player mis à jour" || true
        ok "Jellyfin à jour"
    fi

    log "Configuration des permissions flatpak"
    if ! getent group flatpak >/dev/null 2>&1; then
        sudo groupadd flatpak
    fi
    if ! groups "$REAL_USER" | grep -q '\bflatpak\b'; then
        sudo usermod -a -G flatpak "$REAL_USER"
    fi
    flatpak override --user --socket=x11 --share=network \
        com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    ok "Flatpak et Jellyfin configurés"
}

clone_or_update_repo() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log "Clonage du dépôt XeLauncher"
        git clone "$REPO_URL" "$INSTALL_DIR"
        ok "Dépôt cloné"
        done_action "Dépôt XeLauncher cloné dans $INSTALL_DIR"
    else
        log "Mise à jour du dépôt"
        cd "$INSTALL_DIR"
        git stash push -m "auto-stash" 2>/dev/null || true
        git pull --rebase || { error "Échec de la mise à jour du dépôt"; exit 1; }
        ok "Dépôt mis à jour"
        done_action "Dépôt XeLauncher mis à jour"
    fi
}

fix_package_json() {
    cd "$INSTALL_DIR"
    local changed=0

    if [[ ! -f "package.json" ]]; then
        log "Création de package.json"
        cat > package.json <<'EOF'
{
  "name": "xelauncher",
  "version": "1.0.0",
  "main": "src/JSs/main.js",
  "scripts": {
    "start": "electron ."
  },
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "electron-reload": "^1.5.0"
  },
  "author": "Xelopteryx"
}
EOF
        changed=1
    else
        if grep -q '"main": "src/main.js"' package.json 2>/dev/null; then
            sed -i 's|"main": "src/main.js"|"main": "src/JSs/main.js"|' package.json
            changed=1
        fi
        if grep -q '"electron-reload": "\\^2\\.0\\.0"' package.json 2>/dev/null; then
            sed -i 's/"electron-reload": "\\^2\\.0\\.0"/"electron-reload": "^1.5.0"/' package.json
            changed=1
        fi
    fi

    [[ $changed -eq 1 ]] && done_action "package.json créé/corrigé (main: src/JSs/main.js)"
}

install_npm_deps() {
    cd "$INSTALL_DIR"
    fix_package_json

    local needs_install=0
    if [[ ! -d "node_modules" ]]; then
        needs_install=1
    else
        local pkg_hash lock_hash
        pkg_hash=$(md5sum package.json 2>/dev/null | cut -d' ' -f1 || echo "")
        lock_hash=$(cat "node_modules/.pkg.hash" 2>/dev/null || echo "")
        [[ "$pkg_hash" != "$lock_hash" ]] && needs_install=1
    fi

    if [[ $needs_install -eq 0 ]]; then
        ok "Dépendances npm déjà à jour"
        return 0
    fi

    log "Installation des dépendances npm"
    npm install
    md5sum package.json 2>/dev/null | cut -d' ' -f1 > node_modules/.pkg.hash || true
    ok "Dépendances npm installées"
    done_action "Dépendances npm installées"
}

install_retropie() {
    if [[ $HAS_RETROPIE -eq 1 ]]; then
        ok "RetroPie déjà installé"
        return 0
    fi

    log "Installation de RetroPie (20-40 minutes)"

    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup"
    fi

    cd "$HOME/RetroPie-Setup"
    git pull --rebase 2>/dev/null || true

    exec >/dev/tty 2>&1
    sudo __nodialog=1 ./retropie_packages.sh setup basic_install
    exec > >(tee -a "$LOG_FILE") 2>&1

    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}

    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie installé avec succès"
        done_action "RetroPie installé (basic_install)"
    else
        warn "RetroPie n'a pas pu être confirmé. Vérifiez $LOG_FILE"
    fi
}

configure_splashscreen() {
    local logo="$INSTALL_DIR/src/LOGOs/prometheus.png"
    if [[ -f "$logo" ]]; then
        mkdir -p "$RETROPIE_SPLASH_DIR"
        cp "$logo" "$RETROPIE_SPLASH_DIR/prometheus.png"
        sudo mkdir -p "$(dirname "$RETROPIE_SPLASH_LIST")"
        echo "$RETROPIE_SPLASH_DIR/prometheus.png" | sudo tee "$RETROPIE_SPLASH_LIST" >/dev/null
        ok "Splashscreen RetroPie configuré"
        done_action "Splashscreen Prometheus configuré"
    else
        warn "Logo introuvable à $logo — splashscreen ignoré"
    fi
}

create_start_script() {
    cat > "$INSTALL_DIR/start.sh" <<'EOF'
#!/bin/bash
exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp
EOF
    chmod +x "$INSTALL_DIR/start.sh"
    ok "Script start.sh créé"

    cat > "$HOME/.xinitrc" <<EOF
#!/bin/bash
xset s off
xset -dpms
xset s noblank

cd "$INSTALL_DIR"

if [ -f "./node_modules/.bin/electron" ]; then
    exec ./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage
else
    exec npx electron . --no-sandbox --disable-dev-shm-usage
fi
EOF
    chmod +x "$HOME/.xinitrc"
    ok "Fichier .xinitrc créé"
    done_action "~/.xinitrc et start.sh créés"
}

configure_autologin() {
    if command -v raspi-config >/dev/null 2>&1; then
        log "Configuration de l'autologin console via raspi-config"
        sudo raspi-config nonint do_boot_behaviour B2
        ok "Autologin console configuré"
        done_action "Autologin TTY1 configuré via raspi-config"
    else
        log "Configuration manuelle de l'autologin sur TTY1"
        sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
        cat <<EOF | sudo tee /etc/systemd/system/getty@tty1.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $REAL_USER --noclear %I \$TERM
EOF
        sudo systemctl daemon-reload
        ok "Autologin configuré manuellement"
        done_action "Autologin TTY1 configuré manuellement (systemd)"
    fi

    local BASH_PROFILE="$HOME/.bash_profile"

    if ! grep -q "XeLauncher" "$BASH_PROFILE" 2>/dev/null; then
        if ! grep -q '\.bashrc' "$BASH_PROFILE" 2>/dev/null; then
            echo '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"' >> "$BASH_PROFILE"
        fi
        cat >> "$BASH_PROFILE" <<'EOF'

# Lancement de XeLauncher (Prometheus Entertainment System)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    echo "Démarrage de XeLauncher..."
    exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp
fi
EOF
        ok "XeLauncher ajouté au démarrage dans .bash_profile"
        done_action "~/.bash_profile configuré (startx sur TTY1)"
    else
        if grep -q "exec startx ./start.sh\|cd.*xelauncher" "$BASH_PROFILE" 2>/dev/null; then
            sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$BASH_PROFILE"
            cat >> "$BASH_PROFILE" <<'EOF'

# Lancement de XeLauncher (Prometheus Entertainment System)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    echo "Démarrage de XeLauncher..."
    exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp
fi
EOF
            ok ".bash_profile mis à jour (ancienne entrée corrigée)"
            done_action "~/.bash_profile corrigé"
        else
            ok "XeLauncher déjà correctement configuré dans .bash_profile"
        fi
    fi

    if grep -q "XeLauncher" "$HOME/.profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.profile"
        done_action "~/.profile nettoyé (doublon supprimé)"
    fi
}

configure_systemd_service() {
    if systemctl is-enabled xelauncher 2>/dev/null | grep -q "enabled"; then
        sudo systemctl disable xelauncher 2>/dev/null || true
        sudo systemctl stop xelauncher 2>/dev/null || true
        sudo rm -f /etc/systemd/system/xelauncher.service
        sudo systemctl daemon-reload
    fi

    sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher Kiosk (fallback)
After=systemd-user-sessions.service

[Service]
Type=simple
User=$REAL_USER
Group=$REAL_USER
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
Environment=HOME=/home/$REAL_USER
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$REAL_USER")
ExecStart=/usr/bin/startx /home/$REAL_USER/.xinitrc -- :0 vt1 -nolisten tcp
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    ok "Service systemd de fallback créé (non activé)"
    done_action "Service systemd xelauncher.service créé (fallback, non activé)"
}

configure_sudoers() {
    echo "$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/tailscale up" \
        | sudo tee "$SUDOERS_FILE" > /dev/null
    sudo chmod 440 "$SUDOERS_FILE"
    ok "Règles sudoers configurées"
    done_action "Règles sudoers configurées ($SUDOERS_FILE)"
}

create_required_dirs() {
    mkdir -p \
        "$INSTALL_DIR/src/AVATARs" \
        "$INSTALL_DIR/src/LOGOs" \
        "$INSTALL_DIR/src/HTMLs" \
        "$INSTALL_DIR/src/JSs" \
        "$INSTALL_DIR/src/CSSs"
    ok "Dossiers src/ créés (AVATARs, LOGOs, HTMLs, JSs, CSSs)"
    done_action "Dossiers src/ créés/vérifiés"
}

# ─────────────────────────────────────────────
#  DÉSINSTALLATION
# ─────────────────────────────────────────────
uninstall_all() {
    section "Désinstallation de XeLauncher"

    if [[ -d "$INSTALL_DIR" ]]; then
        log "Suppression du dépôt $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
        ok "Dépôt supprimé"
        done_action "Dépôt $INSTALL_DIR supprimé"
    fi

    if [[ -f "$HOME/.xinitrc" ]]; then
        rm -f "$HOME/.xinitrc"
        ok "~/.xinitrc supprimé"
        done_action "~/.xinitrc supprimé"
    fi

    if grep -q "XeLauncher" "$HOME/.bash_profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.bash_profile"
        ok ".bash_profile nettoyé"
        done_action "~/.bash_profile nettoyé"
    fi

    if grep -q "XeLauncher" "$HOME/.profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.profile"
        done_action "~/.profile nettoyé"
    fi

    if [[ -f "/etc/systemd/system/xelauncher.service" ]]; then
        sudo systemctl disable xelauncher 2>/dev/null || true
        sudo systemctl stop xelauncher 2>/dev/null || true
        sudo rm -f /etc/systemd/system/xelauncher.service
        sudo systemctl daemon-reload
        ok "Service systemd supprimé"
        done_action "Service systemd xelauncher.service supprimé"
    fi

    if [[ -f "$SUDOERS_FILE" ]]; then
        sudo rm -f "$SUDOERS_FILE"
        ok "Règles sudoers supprimées"
        done_action "Règles sudoers supprimées"
    fi

    if flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1; then
        log "Désinstallation de Jellyfin Media Player"
        sudo flatpak uninstall -y com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
        ok "Jellyfin désinstallé"
        done_action "Jellyfin Media Player désinstallé"
    fi

    if command -v emulationstation >/dev/null 2>&1 || [[ -d "$HOME/RetroPie-Setup" ]]; then
        log "Désinstallation de RetroPie"
        if [[ -d "$HOME/RetroPie-Setup" ]]; then
            cd "$HOME/RetroPie-Setup"
            exec >/dev/tty 2>&1
            sudo __nodialog=1 ./retropie_packages.sh setup remove_all 2>/dev/null || true
            exec > >(tee -a "$LOG_FILE") 2>&1
        fi
        rm -rf "$HOME/RetroPie-Setup"
        ok "RetroPie désinstallé"
        done_action "RetroPie désinstallé"
    fi

    if command -v node >/dev/null 2>&1; then
        log "Désinstallation de Node.js"
        sudo apt-get remove -y nodejs 2>/dev/null || true
        sudo rm -f /etc/apt/sources.list.d/nodesource.list
        ok "Node.js désinstallé"
        done_action "Node.js désinstallé"
    fi

    if command -v tailscale >/dev/null 2>&1; then
        log "Désinstallation de Tailscale"
        sudo systemctl stop tailscaled 2>/dev/null || true
        sudo systemctl disable tailscaled 2>/dev/null || true
        sudo apt-get remove -y tailscale 2>/dev/null || true
        sudo rm -f /etc/apt/sources.list.d/tailscale.list
        ok "Tailscale désinstallé"
        done_action "Tailscale désinstallé"
    fi

    if [[ -f "$RETROPIE_SPLASH_DIR/prometheus.png" ]]; then
        rm -f "$RETROPIE_SPLASH_DIR/prometheus.png"
        done_action "Splashscreen supprimé"
    fi

    rm -f "$LOCK_FILE"

    ok "Désinstallation terminée"
}

# ─────────────────────────────────────────────
#  RÉSUMÉ FINAL
# ─────────────────────────────────────────────
print_summary() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    if [[ "$MODE" == "install" ]]; then
        echo -e "${GREEN}✔ Installation terminée avec succès !${RESET}"
    else
        echo -e "${GREEN}✔ Désinstallation terminée !${RESET}"
    fi
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo ""

    if [[ ${#ACTIONS_DONE[@]} -eq 0 ]]; then
        echo "  Aucune action effectuée (tout était déjà en ordre)."
    else
        echo "  Ce qui a été effectué :"
        for action in "${ACTIONS_DONE[@]}"; do
            echo -e "    ${GREEN}•${RESET} $action"
        done
    fi

    echo ""
    if [[ "$MODE" == "install" ]]; then
        echo -e "  ${CYAN}Redémarrez maintenant :${RESET} sudo reboot"
    fi
    echo ""
}

# ─────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────
main() {
    # Parse des arguments
    for arg in "$@"; do
        case "$arg" in
            --i) AUTO_MODE="install" ;;
            --u) AUTO_MODE="uninstall" ;;
            *)
                echo -e "${RED}✖${RESET} Argument inconnu : $arg" >&2
                echo "  Usage : $0 [--i | --u]" >&2
                echo "    --i  Installer directement sans menu interactif" >&2
                echo "    --u  Désinstaller directement sans menu interactif" >&2
                exit 1
                ;;
        esac
    done

    # Vérifications préalables — AVANT exec tee pour garder stdin intact
    if [[ $EUID -eq 0 ]]; then
        echo -e "\033[1;31m✖\033[0m N'exécutez pas ce script en root." >&2
        exit 1
    fi

    REAL_USER="${SUDO_USER:-$USER}"
    export HOME="/home/$REAL_USER"

    sudo -v || { echo "Droits sudo requis" >&2; exit 1; }

    curl -Is https://github.com | head -n1 | grep -q 200 \
        || { echo "Connexion Internet requise" >&2; exit 1; }

    # Menu interactif — AVANT la redirection tee (stdin doit rester sur le TTY)
    interactive_menu

    # Rediriger stdout/stderr vers log APRÈS le menu
    exec > >(tee -a "$LOG_FILE") 2>&1

    # Activer le trap d'erreur
    setup_trap

    if [[ "$MODE" == "uninstall" ]]; then
        uninstall_all
        print_summary
        exit 0
    fi

    # ── MODE INSTALL ──
    section "1/9 — Mise à jour système"
    sudo apt-get update -q
    ok "Paquets à jour"

    section "2/9 — Dépendances système"
    check_and_install_packages \
        git curl wget \
        network-manager \
        bluetooth bluez bluez-tools \
        flatpak \
        xdotool \
        xserver-xorg xinit \
        unzip jq dialog xmlstarlet \
        fbi \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
        libxss1 libxtst6 libgtk-3-0

    section "3/9 — Node.js"
    install_nodejs

    section "4/9 — Tailscale"
    install_tailscale

    section "5/9 — Flatpak + Jellyfin"
    install_flatpak_jellyfin

    section "6/9 — Clonage du dépôt"
    clone_or_update_repo

    section "7/9 — Dépendances Node"
    install_npm_deps

    section "8/9 — RetroPie"
    install_retropie

    section "9/9 — Configuration du système"
    configure_splashscreen
    create_start_script
    configure_autologin
    configure_systemd_service
    configure_sudoers
    create_required_dirs

    touch "$LOCK_FILE"
    print_summary
}

main "$@"
