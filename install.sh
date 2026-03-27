#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5             |
# |                 Version totalement automatisée               |
# +--------------------------------------------------------------+

set -euo pipefail
trap 'error "Erreur fatale à la ligne $LINENO. Voir $LOG_FILE"' ERR

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
readonly RESET='\033[0m'

# Options
YES_MODE=0
FORCE_MODE=0
SKIP_RETROPIE=0

# Logging
log() { echo -e "${CYAN}→${RESET} $1"; }
ok() { echo -e "${GREEN}✔${RESET} $1"; }
warn() { echo -e "${YELLOW}!${RESET} $1"; }
error() { echo -e "${RED}✖${RESET} $1" >&2; }

section() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo -e "${WHITE}$1${RESET}"
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
}

usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --yes            Mode automatique
  --force          Force la réinstallation
  --skip-retropie  Saute RetroPie
  --help           Aide
EOF
    exit 0
}

# Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes) YES_MODE=1; shift ;;
        --force) FORCE_MODE=1; shift ;;
        --skip-retropie) SKIP_RETROPIE=1; shift ;;
        --help) usage ;;
        *) error "Option inconnue"; usage ;;
    esac
done

exec > >(tee -a "$LOG_FILE") 2>&1

# Vérifications
if [[ $EUID -eq 0 ]]; then
    error "Ne pas exécuter en root"
    exit 1
fi

sudo -v || { error "Droits sudo requis"; exit 1; }

if [[ -f "$LOCK_FILE" ]] && [[ $FORCE_MODE -eq 0 ]]; then
    warn "XeLauncher déjà installé. Utilisez --force pour réinstaller."
    exit 0
fi

curl -Is https://github.com | head -n1 | grep -q 200 || { error "Internet requis"; exit 1; }

REAL_USER="${SUDO_USER:-$USER}"
export HOME="/home/$REAL_USER"

# Fonctions d'installation
check_and_install_packages() {
    local to_install=()
    for pkg in "$@"; do
        if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
            to_install+=("$pkg")
        fi
    done
    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installation: ${to_install[*]}"
        sudo apt-get install -y "${to_install[@]}"
    fi
}

install_nodejs() {
    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            ok "Node.js $(node -v) déjà installé"
            return 0
        fi
    fi
    log "Installation Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node_setup.sh
    sudo bash /tmp/node_setup.sh
    rm /tmp/node_setup.sh
    sudo apt-get install -y nodejs
    ok "Node.js installé: $(node -v)"
}

install_tailscale() {
    if command -v tailscale >/dev/null 2>&1; then
        ok "Tailscale déjà installé"
        return 0
    fi
    log "Installation Tailscale"
    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh
    sudo bash /tmp/tailscale_install.sh
    rm /tmp/tailscale_install.sh
    sudo systemctl enable --now tailscaled
    ok "Tailscale installé"
}

install_flatpak_jellyfin() {
    if ! command -v flatpak >/dev/null 2>&1; then
        sudo apt-get install -y flatpak
    fi
    
    sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
    
    if ! flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1; then
        log "Installation Jellyfin Media Player"
        exec >/dev/tty 2>&1
        sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player
        exec > >(tee -a "$LOG_FILE") 2>&1
        ok "Jellyfin installé"
    else
        ok "Jellyfin déjà installé"
    fi
    
    log "Configuration permissions flatpak"
    if ! getent group flatpak >/dev/null 2>&1; then
        sudo groupadd flatpak
    fi
    if ! groups "$REAL_USER" | grep -q "\bflatpak\b"; then
        sudo usermod -a -G flatpak "$REAL_USER"
    fi
    flatpak override --user --socket=x11 --share=network com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    ok "Flatpak configuré"
}

clone_or_update_repo() {
    if [[ -d "$INSTALL_DIR" ]] && [[ $FORCE_MODE -eq 1 ]]; then
        rm -rf "$INSTALL_DIR"
    fi
    
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log "Clonage du dépôt"
        git clone "$REPO_URL" "$INSTALL_DIR"
    else
        log "Mise à jour du dépôt"
        cd "$INSTALL_DIR"
        git stash push -m "auto-stash" 2>/dev/null || true
        git pull --rebase || { error "Échec pull"; exit 1; }
    fi
    ok "Dépôt prêt"
}

install_npm_deps() {
    cd "$INSTALL_DIR"
    
    # Correction package.json si nécessaire
    if [[ -f "package.json" ]]; then
        if grep -q '"electron-reload": "\^2\.0\.0"' package.json; then
            log "Correction package.json"
            sed -i 's/"electron-reload": "\^2\.0\.0"/"electron-reload": "\^1.5.0"/' package.json
        fi
    fi
    
    if [[ ! -f "package.json" ]]; then
        cat > package.json <<'EOF'
{
  "name": "xelauncher",
  "version": "1.0.0",
  "main": "src/main.js",
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "electron-reload": "^1.5.0"
  }
}
EOF
    fi
    
    # Vérification des dépendances
    if [[ -d "node_modules" ]]; then
        local pkg_hash=""
        local lock_hash=""
        if [[ -f "package.json" ]]; then
            pkg_hash=$(md5sum package.json | cut -d' ' -f1)
        fi
        if [[ -f "node_modules/.package-lock.json.hash" ]]; then
            lock_hash=$(cat "node_modules/.package-lock.json.hash")
        fi
        if [[ "$pkg_hash" == "$lock_hash" ]] && [[ -n "$pkg_hash" ]]; then
            ok "Dépendances npm déjà à jour."
            return 0
        fi
    fi
    
    log "Installation des dépendances npm"
    npm install
    if [[ -f "package.json" ]]; then
        md5sum package.json | cut -d' ' -f1 > node_modules/.package-lock.json.hash
    fi
    ok "Dépendances npm installées."
}

install_retropie() {
    if [[ $SKIP_RETROPIE -eq 1 ]]; then
        log "RetroPie ignoré"
        return 0
    fi
    
    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie déjà installé"
        return 0
    fi
    
    log "Installation de RetroPie (20-40 minutes)"
    
    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup"
    fi
    
    cd "$HOME/RetroPie-Setup"
    
    # Installation automatique
    exec >/dev/tty 2>&1
    log "Lancement de l'installation automatique..."
    sudo ./retropie_setup.sh auto
    exec > >(tee -a "$LOG_FILE") 2>&1
    
    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}
    
    ok "RetroPie installé"
}

configure_splashscreen() {
    local logo="$INSTALL_DIR/src/logos/Prometheus.png"
    if [[ -f "$logo" ]]; then
        mkdir -p "$RETROPIE_SPLASH_DIR"
        cp "$logo" "$RETROPIE_SPLASH_DIR/prometheus.png"
        sudo mkdir -p "$(dirname "$RETROPIE_SPLASH_LIST")"
        echo "$RETROPIE_SPLASH_DIR/prometheus.png" | sudo tee "$RETROPIE_SPLASH_LIST" >/dev/null
        ok "Splashscreen configuré"
    else
        warn "Logo non trouvé"
    fi
}

create_start_script() {
    cat > "$INSTALL_DIR/start.sh" <<'EOF'
#!/bin/bash
export DISPLAY=:0
cd "$(dirname "$0")"
if [ -f "./node_modules/.bin/electron" ]; then
    exec ./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage
else
    exec npx electron . --no-sandbox --disable-dev-shm-usage
fi
EOF
    chmod +x "$INSTALL_DIR/start.sh"
    ok "Script start.sh créé"
}

configure_autologin() {
    if command -v raspi-config >/dev/null 2>&1; then
        sudo raspi-config nonint do_boot_behaviour B2
        ok "Autologin configuré"
    fi
}

configure_systemd_service() {
    sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher
After=network.target

[Service]
User=$REAL_USER
WorkingDirectory=$INSTALL_DIR
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/startx $INSTALL_DIR/start.sh -- :0
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable xelauncher
    ok "Service activé"
}

configure_sudoers() {
    echo "$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/tailscale up" | sudo tee "$SUDOERS_FILE" > /dev/null
    sudo chmod 440 "$SUDOERS_FILE"
    ok "Sudoers configuré"
}

create_required_dirs() {
    mkdir -p "$INSTALL_DIR/avatars"
    ok "Dossiers créés"
}

# Main
main() {
    clear
    echo -e "${WHITE}XeLauncher Installer (version automatisée)${RESET}"
    echo ""
    
    if [[ $YES_MODE -eq 0 ]]; then
        read -p "Appuie sur Entrée pour continuer..."
    fi
    
    section "1/9 — Mise à jour"
    sudo apt-get update
    
    section "2/9 — Dépendances"
    check_and_install_packages git curl wget network-manager bluetooth bluez-tools flatpak xdotool xserver-xorg xinit unzip jq dialog xmlstarlet fbi libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libxss1 libxtst6 libgtk-3-0
    
    section "3/9 — Node.js"
    install_nodejs
    
    section "4/9 — Tailscale"
    install_tailscale
    
    section "5/9 — Jellyfin"
    install_flatpak_jellyfin
    
    section "6/9 — Dépôt"
    clone_or_update_repo
    
    section "7/9 — Dépendances Node"
    install_npm_deps
    
    section "8/9 — RetroPie"
    install_retropie
    
    section "9/9 — Configuration"
    configure_splashscreen
    create_start_script
    configure_autologin
    configure_systemd_service
    configure_sudoers
    create_required_dirs
    
    touch "$LOCK_FILE"
    
    echo ""
    ok "Installation terminée !"
    echo ""
    echo "Redémarrage : sudo reboot"
}

main "$@"
