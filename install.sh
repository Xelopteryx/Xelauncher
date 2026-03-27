#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5             |
# +--------------------------------------------------------------+

set -e

# -----------------------------
# Variables
# -----------------------------

REPO_URL="https://github.com/Xelopteryx/Xelauncher.git"
INSTALL_DIR="$HOME/xelauncher"
LOCK_FILE="/var/tmp/xelauncher_install.lock"

RETROPIE_SPLASH_DIR="$HOME/RetroPie/splashscreens"
RETROPIE_SPLASH_LIST="/opt/retropie/configs/all/splashscreen.list"

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
RESET='\033[0m'

log() { echo -e "${CYAN}→${RESET} $1"; }
ok() { echo -e "${GREEN}✔${RESET} $1"; }
warn() { echo -e "${YELLOW}!${RESET} $1"; }
error() { echo -e "${RED}✖${RESET} $1"; }

section() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo -e "${WHITE}$1${RESET}"
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
}

# -----------------------------
# Sécurité
# -----------------------------

if [[ -f "$LOCK_FILE" ]]; then
    warn "XeLauncher semble déjà installé sur ce système"
fi

# Vérification Internet
if ! ping -c1 github.com >/dev/null 2>&1; then
    error "Connexion Internet requise"
    exit 1
fi

# Vérification Raspberry Pi
if ! grep -q "Raspberry" /proc/device-tree/model 2>/dev/null; then
    warn "Ce script est prévu pour Raspberry Pi"
fi

# Vérification RAM
RAM=$(free -m | awk '/Mem:/ {print $2}')
if [[ $RAM -lt 2000 ]]; then
    warn "Moins de 2GB de RAM détecté, Electron peut être lent"
fi

clear

echo -e "${WHITE}XeLauncher installer${RESET}"
echo ""

if [[ "$1" != "--yes" ]]; then
    read -p "Appuie sur Entrée pour commencer l'installation..."
fi

# -----------------------------
section "1/8 — Mise à jour système"
# -----------------------------

sudo apt-get update
sudo apt-get upgrade -y

ok "Système à jour"

# -----------------------------
section "2/8 — Dépendances système"
# -----------------------------

sudo apt-get install -y \
    git curl wget \
    network-manager \
    bluetooth bluez bluez-tools \
    flatpak \
    xdotool \
    xserver-xorg xinit \
    unzip jq dialog xmlstarlet \
    fbi \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2

ok "Dépendances installées"

# -----------------------------
section "3/8 — Node.js"
# -----------------------------

if command -v node >/dev/null 2>&1; then

    ok "Node déjà présent ($(node -v))"

else

    log "Installation Node.js"

    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node_setup.sh
    sudo bash /tmp/node_setup.sh
    rm /tmp/node_setup.sh

    sudo apt-get install -y nodejs

    ok "Node installé ($(node -v))"

fi

# -----------------------------
section "4/8 — Tailscale"
# -----------------------------

if ! command -v tailscale >/dev/null 2>&1; then

    log "Installation Tailscale"

    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh
    sudo bash /tmp/tailscale_install.sh
    rm /tmp/tailscale_install.sh

fi

sudo systemctl enable tailscaled
sudo systemctl start tailscaled

ok "Tailscale prêt"

# -----------------------------
section "5/8 — Flatpak + Jellyfin"
# -----------------------------

sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

if ! flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1; then

    log "Installation Jellyfin Media Player"

    sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player

fi

ok "Jellyfin prêt"

# -----------------------------
section "6/8 — Clonage XeLauncher"
# -----------------------------

if [[ ! -d "$INSTALL_DIR" ]]; then

    log "Clonage du dépôt XeLauncher"

    git clone "$REPO_URL" "$INSTALL_DIR"

else

    log "Mise à jour du dépôt"

    git -C "$INSTALL_DIR" pull

fi

ok "Sources XeLauncher prêtes"

# -----------------------------
section "7/8 — Installation Node"
# -----------------------------

cd "$INSTALL_DIR"

if [[ -f "package.json" ]]; then

    log "Installation dépendances npm"

    npm install

else

    warn "package.json absent"

fi

# -----------------------------
section "8/8 — Installation RetroPie"
# -----------------------------

if ! command -v emulationstation >/dev/null 2>&1; then

    log "Installation RetroPie (cela peut prendre longtemps)"

    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup"
    fi

    cd "$HOME/RetroPie-Setup"

    sudo ./retropie_setup.sh auto

    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}

    ok "RetroPie installé"

else

    ok "RetroPie déjà présent"

fi

# -----------------------------
section "Configuration splashscreen RetroPie"
# -----------------------------

PROMETHEUS_LOGO="$INSTALL_DIR/src/logos/Prometheus.png"

if [[ -f "$PROMETHEUS_LOGO" ]]; then

    log "Configuration du splashscreen Prometheus"

    mkdir -p "$RETROPIE_SPLASH_DIR"

    cp "$PROMETHEUS_LOGO" "$RETROPIE_SPLASH_DIR/prometheus.png"

    sudo mkdir -p /opt/retropie/configs/all

    echo "$RETROPIE_SPLASH_DIR/prometheus.png" | sudo tee "$RETROPIE_SPLASH_LIST" >/dev/null

    ok "Splashscreen RetroPie configuré"

else

    warn "Prometheus.png introuvable dans src/logos"

fi

# -----------------------------
section "Script de lancement XeLauncher"
# -----------------------------

cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/bash

export DISPLAY=:0
cd "$INSTALL_DIR"

exec npx electron . --no-sandbox --disable-dev-shm-usage
EOF

chmod +x "$INSTALL_DIR/start.sh"

ok "Script start.sh créé"

# -----------------------------
section "Service systemd XeLauncher"
# -----------------------------

sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher
After=systemd-user-sessions.service network.target

[Service]
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/startx $INSTALL_DIR/start.sh -- :0
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

sudo systemctl enable xelauncher

ok "XeLauncher sera lancé automatiquement au démarrage"

# -----------------------------
section "Final"
# -----------------------------

touch "$LOCK_FILE"

echo ""
ok "Installation terminée"

echo ""
echo "Au prochain reboot :"
echo ""
echo "1. Splashscreen Prometheus"
echo "2. Chargement RetroPie"
echo "3. Lancement automatique XeLauncher"
echo ""
echo "Redémarrer pour tester :"
echo "sudo reboot"
