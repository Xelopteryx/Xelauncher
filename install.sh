#!/bin/bash
# +--------------------------------------------------------------+
# ¦              XeLauncher — Script d'installation              ¦
# ¦           Prometheus Entertainment System — RPI5             ¦
# +--------------------------------------------------------------+
set -e

# -- Couleurs ------------------------------------------------------------------
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2;37m'
RESET='\033[0m'

# -- Helpers -------------------------------------------------------------------
log()     { echo -e "${CYAN}?${RESET} $1"; }
ok()      { echo -e "${GREEN}?${RESET} $1"; }
warn()    { echo -e "${YELLOW}?${RESET}  $1"; }
error()   { echo -e "${RED}?${RESET} $1"; }
section() { echo -e "\n${WHITE}??????????????????????????????????????????????????????????????${RESET}"; echo -e "${WHITE}  $1${RESET}"; echo -e "${WHITE}??????????????????????????????????????????????????????????????${RESET}\n"; }

INSTALL_DIR="$HOME/xelauncher"
USER=$(whoami)

# -- Bannière ------------------------------------------------------------------
clear
echo -e "${WHITE}"
echo "  ¦¦+  ¦¦+¦¦¦¦¦¦¦+¦¦+      ¦¦¦¦¦+ ¦¦+   ¦¦+¦¦¦+   ¦¦+ ¦¦¦¦¦¦+¦¦+  ¦¦+¦¦¦¦¦¦¦+¦¦¦¦¦¦+ "
echo "  +¦¦+¦¦++¦¦+----+¦¦¦     ¦¦+--¦¦+¦¦¦   ¦¦¦¦¦¦¦+  ¦¦¦¦¦+----+¦¦¦  ¦¦¦¦¦+----+¦¦+--¦¦+"
echo "   +¦¦¦++ ¦¦¦¦¦+  ¦¦¦     ¦¦¦¦¦¦¦¦¦¦¦   ¦¦¦¦¦+¦¦+ ¦¦¦¦¦¦     ¦¦¦¦¦¦¦¦¦¦¦¦¦+  ¦¦¦¦¦¦++"
echo "   ¦¦+¦¦+ ¦¦+--+  ¦¦¦     ¦¦+--¦¦¦¦¦¦   ¦¦¦¦¦¦+¦¦+¦¦¦¦¦¦     ¦¦+--¦¦¦¦¦+--+  ¦¦+--¦¦+"
echo "  ¦¦++ ¦¦+¦¦¦¦¦¦¦+¦¦¦¦¦¦¦+¦¦¦  ¦¦¦+¦¦¦¦¦¦++¦¦¦ +¦¦¦¦¦+¦¦¦¦¦¦+¦¦¦  ¦¦¦¦¦¦¦¦¦¦+¦¦¦  ¦¦¦"
echo "  +-+  +-++------++------++-+  +-+ +-----+ +-+  +---+ +-----++-+  +-++------++-+  +-+"
echo -e "${RESET}"
echo -e "${DIM}                    Script d'installation v2.0${RESET}"
echo -e "${DIM}              Prometheus Entertainment System - RPI5${RESET}"
echo ""
echo -e "${YELLOW}  Utilisateur : ${WHITE}$USER${RESET}"
echo -e "${YELLOW}  Dossier     : ${WHITE}$INSTALL_DIR${RESET}"
echo ""
read -p "  Appuie sur ENTRÉE pour démarrer l'installation..." _

# ------------------------------------------------------------------------------
section "1/8 — Mise à jour du système"
# ------------------------------------------------------------------------------

log "Mise à jour des paquets..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq
ok "Système à jour"

# ------------------------------------------------------------------------------
section "2/8 — Dépendances système"
# ------------------------------------------------------------------------------

log "Installation des paquets requis..."
sudo apt-get install -y -qq \
    curl git wget \
    network-manager \
    bluetooth bluez bluez-tools \
    flatpak \
    xdotool \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    xserver-xorg xinit \
    unzip jq dialog xmlstarlet

ok "Dépendances installées"

# ------------------------------------------------------------------------------
section "3/8 — Node.js"
# ------------------------------------------------------------------------------

if command -v node &>/dev/null && [[ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -ge 18 ]]; then
    ok "Node.js $(node -v) déjà installé"
else
    log "Installation de Node.js 20 LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
    ok "Node.js $(node -v) installé"
fi

# ------------------------------------------------------------------------------
section "4/8 — Tailscale (VPN)"
# ------------------------------------------------------------------------------

if command -v tailscale &>/dev/null; then
    ok "Tailscale déjà installé ($(tailscale version 2>/dev/null | head -1))"
else
    log "Installation de Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
    ok "Tailscale installé"
fi

log "Activation du service tailscaled..."
sudo systemctl enable tailscaled --quiet 2>/dev/null || true
sudo systemctl start tailscaled 2>/dev/null || true
ok "Service tailscaled actif"

# ------------------------------------------------------------------------------
section "5/8 — Flatpak + Jellyfin Media Player"
# ------------------------------------------------------------------------------

log "Ajout du dépôt Flathub..."
sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo 2>/dev/null || true

if sudo flatpak list --system 2>/dev/null | grep -q "jellyfin-media-player"; then
    ok "Jellyfin Media Player déjà installé"
else
    log "Installation de Jellyfin Media Player (peut prendre quelques minutes)..."
    sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    ok "Jellyfin Media Player installé"
fi

# ------------------------------------------------------------------------------
section "6/8 — Parsec"
# ------------------------------------------------------------------------------

if command -v parsecd &>/dev/null; then
    ok "Parsec déjà installé"
else
    log "Installation de Parsec..."
    
    cd /tmp
    wget -q -O parsec.deb https://builds.parsecgaming.com/package/parsec-linux.deb || true
    
    if [[ -f parsec.deb ]]; then
        sudo apt-get install -y -qq \
            libegl1-mesa-dev libgles2-mesa-dev \
            libx11-xcb1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
            libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 \
            libxcb-xfixes0 libxcb-xkb1 libxkbcommon-x11-0 2>/dev/null || true
        
        sudo dpkg -i parsec.deb 2>/dev/null || sudo apt-get install -f -y -qq 2>/dev/null || true
        
        # Création du groupe parsec s'il n'existe pas
        if ! getent group parsec > /dev/null; then
            sudo groupadd parsec 2>/dev/null || true
        fi
        
        sudo usermod -a -G parsec $USER 2>/dev/null || true
        rm -f parsec.deb
        ok "Parsec installé"
    else
        warn "Téléchargement Parsec échoué"
    fi
fi

# ------------------------------------------------------------------------------
section "7/8 — XeLauncher"
# ------------------------------------------------------------------------------

log "Création des dossiers..."
mkdir -p "$INSTALL_DIR/src/avatars"
mkdir -p "$INSTALL_DIR/src/css"
mkdir -p "$INSTALL_DIR/src/js"
ok "Dossiers créés : $INSTALL_DIR/src"

# Création du package.json s'il n'existe pas
if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
    log "Création du package.json..."
    cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "name": "xelauncher",
  "version": "1.0.0",
  "description": "Prometheus Entertainment System",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev-tools"
  },
  "dependencies": {},
  "devDependencies": {
    "electron": "^29.0.0"
  }
}
PKGJSON
    ok "package.json créé"
fi

# Installation d'Electron
if [[ ! -d "$INSTALL_DIR/node_modules/electron" ]]; then
    log "Installation d'Electron..."
    cd "$INSTALL_DIR"
    npm install --save-dev electron@29 --quiet 2>/dev/null || {
        warn "Installation Electron via npm échouée, tentative avec sudo..."
        sudo npm install --save-dev electron@29 --quiet 2>/dev/null || true
    }
    ok "Electron installé"
else
    ok "Electron déjà installé"
fi

# Vérification des fichiers sources
MISSING=0
log "Vérification des fichiers sources..."
for f in main.js preload.js menu.html profiles.html; do
    if [[ ! -f "$INSTALL_DIR/src/$f" ]]; then
        warn "Fichier manquant : $INSTALL_DIR/src/$f"
        MISSING=1
    else
        ok "Trouvé : src/$f"
    fi
done

# Vérification des dossiers optionnels
for d in avatars css js logos; do
    if [[ -d "$INSTALL_DIR/src/$d" ]]; then
        ok "Dossier trouvé : src/$d"
    fi
done

# Rendre xeboot.sh exécutable s'il existe
if [[ -f "$INSTALL_DIR/src/xeboot.sh" ]]; then
    chmod +x "$INSTALL_DIR/src/xeboot.sh"
    ok "src/xeboot.sh rendu exécutable"
fi

# Création du script de démarrage
log "Création du script de lancement..."
cat > "$INSTALL_DIR/start.sh" << 'STARTSH'
#!/bin/bash
# XeLauncher - script de demarrage
export DISPLAY=:0
export HOME=/home/'"$USER"'

cd "/home/'"$USER"'/xelauncher"

# Boot anime (si disponible dans src/)
if [[ -f "/home/'"$USER"'/xelauncher/src/xeboot.sh" && -t 1 ]]; then
    bash "/home/'"$USER"'/xelauncher/src/xeboot.sh"
fi

# Lancement Electron
exec npx electron . --no-sandbox --disable-dev-shm-usage
STARTSH

# Remplacer l'utilisateur dans le script
sed -i "s/\/home\/\"/\/home\/$USER\"/g" "$INSTALL_DIR/start.sh"
chmod +x "$INSTALL_DIR/start.sh"
ok "start.sh créé"

if [[ $MISSING -eq 1 ]]; then
    echo ""
    warn "Certains fichiers sources sont manquants dans le dossier src/"
    echo -e "  Structure attendue dans ${WHITE}$INSTALL_DIR/src/${RESET} :"
    echo -e "  ${WHITE}+-- main.js${RESET}"
    echo -e "  ${WHITE}+-- preload.js${RESET}"
    echo -e "  ${WHITE}+-- menu.html${RESET}"
    echo -e "  ${WHITE}+-- profiles.html${RESET}"
    echo -e "  ${WHITE}+-- xeboot.sh${RESET} (optionnel)"
    echo -e "  ${WHITE}+-- avatars/${RESET}"
    echo -e "  ${WHITE}+-- css/${RESET}"
    echo -e "  ${WHITE}+-- js/${RESET}"
    echo -e "  ${WHITE}+-- logos/${RESET}"
    echo ""
fi

# ------------------------------------------------------------------------------
section "8/8 — RetroPie (installation en dernier)"
# ------------------------------------------------------------------------------

if command -v emulationstation &>/dev/null; then
    ok "RetroPie/EmulationStation déjà installé"
else
    log "Installation de RetroPie (cela peut prendre 30-60 minutes)..."
    
    sudo apt-get install -y -qq \
        build-essential cmake git \
        libsdl2-dev libsdl2-image-dev libsdl2-mixer-dev libsdl2-ttf-dev \
        libfreetype6-dev libcurl4-openssl-dev \
        libvlc-dev libvlccore-dev python3-dev python3-pip 2>/dev/null || true
    
    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup" 2>/dev/null || true
    fi
    
    if [[ -d "$HOME/RetroPie-Setup" ]]; then
        cd "$HOME/RetroPie-Setup"
        sudo ./retropie_setup.sh auto 2>/dev/null || true
        mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}
        ok "RetroPie installé"
    else
        warn "Impossible de cloner RetroPie-Setup"
    fi
fi

# ------------------------------------------------------------------------------
# Configuration du démarrage automatique
# ------------------------------------------------------------------------------

section "Configuration finale — Démarrage automatique"

# Droits sudo
SUDOERS_FILE="/etc/sudoers.d/xelauncher"
log "Configuration des droits sudo..."

sudo tee "$SUDOERS_FILE" > /dev/null << SUDOEOF
# XeLauncher - droits sans mot de passe
$USER ALL=(ALL) NOPASSWD: /sbin/reboot
$USER ALL=(ALL) NOPASSWD: /sbin/poweroff
$USER ALL=(ALL) NOPASSWD: /bin/systemctl reboot
$USER ALL=(ALL) NOPASSWD: /bin/systemctl poweroff
$USER ALL=(ALL) NOPASSWD: /bin/systemctl start tailscaled
$USER ALL=(ALL) NOPASSWD: /bin/systemctl stop tailscaled
$USER ALL=(ALL) NOPASSWD: /usr/bin/tailscale
$USER ALL=(ALL) NOPASSWD: /usr/sbin/tailscale
SUDOEOF

sudo chmod 440 "$SUDOERS_FILE" 2>/dev/null || true
ok "Règles sudo configurées"

# Configuration .xinitrc
log "Configuration de X11..."
cat > "$HOME/.xinitrc" << XINITRC
#!/bin/bash
exec "$INSTALL_DIR/start.sh"
XINITRC
chmod +x "$HOME/.xinitrc"

# Configuration du démarrage TTY
log "Configuration du démarrage automatique..."
BASHRC="$HOME/.bashrc"

# Supprimer l'ancienne section si elle existe
sed -i '/# XeLauncher autostart/,/^fi$/d' "$BASHRC" 2>/dev/null || true

# Ajouter la nouvelle section
cat >> "$BASHRC" << BASHRCEOF

# XeLauncher autostart
if [[ "\$(tty)" == "/dev/tty1" ]] && [[ -z "\$DISPLAY" ]]; then
    if [[ -f "$INSTALL_DIR/src/xeboot.sh" ]]; then
        bash "$INSTALL_DIR/src/xeboot.sh"
    fi
    startx -- -nocursor
fi
BASHRCEOF
ok "Démarrage TTY configuré"

# Service systemd
log "Création du service systemd..."
sudo tee "/etc/systemd/system/xelauncher.service" > /dev/null << SVCEOF
[Unit]
Description=XeLauncher - Prometheus Entertainment System
After=graphical.target

[Service]
Type=simple
User=$USER
Environment=DISPLAY=:0
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/start.sh
Restart=on-failure

[Install]
WantedBy=graphical.target
SVCEOF

sudo systemctl daemon-reload 2>/dev/null || true
ok "Service systemd créé"

# ------------------------------------------------------------------------------
# Récapitulatif final
# ------------------------------------------------------------------------------

echo ""
echo -e "${WHITE}??????????????????????????????????????????????????????????????${RESET}"
echo -e "${GREEN}  ?  Installation terminée !${RESET}"
echo -e "${WHITE}??????????????????????????????????????????????????????????????${RESET}"
echo ""
echo -e "${YELLOW}  Prochaines étapes :${RESET}"
echo ""

if [[ $MISSING -eq 1 ]]; then
    echo -e "  ${RED}? Copier les fichiers sources manquants dans :${RESET}"
    echo -e "     ${WHITE}$INSTALL_DIR/src/${RESET}"
    echo ""
fi

echo -e "  ${CYAN}? Connecter Tailscale :${RESET}"
echo -e "     ${DIM}sudo tailscale up${RESET}"
echo ""
echo -e "  ${CYAN}? Connecter Parsec :${RESET}"
echo -e "     ${DIM}parsec${RESET}"
echo ""
echo -e "  ${CYAN}? Ajouter vos ROMs :${RESET}"
echo -e "     ${DIM}$HOME/RetroPie/roms/${RESET}"
echo ""
echo -e "  ${CYAN}? Tester XeLauncher :${RESET}"
echo -e "     ${DIM}startx${RESET}"
echo ""
echo -e "  ${CYAN}? Activer le service systemd (optionnel) :${RESET}"
echo -e "     ${DIM}sudo systemctl enable xelauncher --now${RESET}"
echo ""
echo -e "  ${CYAN}? Redémarrer :${RESET}"
echo -e "     ${DIM}sudo reboot${RESET}"
echo ""