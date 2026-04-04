/**
 * XeLauncher — main.js
 * Electron main process
 *
 * Stratégie de lancement RetroArch / Jellyfin :
 *   On QUITTE Electron proprement avant de spawner l'application,
 *   puis le script wrapper xelauncher.sh relance Electron au retour.
 *   Cela laisse les ressources X11/GPU entièrement libres.
 */

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker } = require('electron')
const path = require('path')
const { exec, spawn, execSync } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

/* ── Secret key (chiffrement des mots de passe) ──────────────────────────── */
const SECRET_KEY_FILE = path.join(os.homedir(), 'xelauncher', '.secret.key')
let SECRET_KEY = null

function getOrCreateSecretKey() {
  if (SECRET_KEY) return SECRET_KEY
  try {
    SECRET_KEY = fs.existsSync(SECRET_KEY_FILE)
      ? fs.readFileSync(SECRET_KEY_FILE, 'utf8')
      : (() => {
          const k = crypto.randomBytes(32).toString('hex')
          fs.mkdirSync(path.dirname(SECRET_KEY_FILE), { recursive: true })
          fs.writeFileSync(SECRET_KEY_FILE, k)
          return k
        })()
  } catch(e) {
    SECRET_KEY = 'xelauncher-static-key-fallback-2024'
  }
  return SECRET_KEY
}

function encrypt(text) {
  if (!text) return ''
  try {
    const key = getOrCreateSecretKey().padEnd(32,'0').slice(0,32)
    const iv  = crypto.randomBytes(16)
    const c   = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv)
    const enc = Buffer.concat([c.update(text,'utf8'), c.final()])
    return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex')
  } catch(e) { return text }
}

function decrypt(text) {
  if (!text) return ''
  try {
    const parts = text.split(':')
    if (parts.length !== 3) return text
    const key = getOrCreateSecretKey().padEnd(32,'0').slice(0,32)
    const d   = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(parts[0],'hex'))
    d.setAuthTag(Buffer.from(parts[1],'hex'))
    return d.update(Buffer.from(parts[2],'hex'), null, 'utf8') + d.final('utf8')
  } catch(e) { return text }
}

/* ── Paths ─────────────────────────────────────────────────────────────────── */
const BASE_DIR      = path.join(os.homedir(), 'xelauncher')
const PROFILES_PATH = path.join(BASE_DIR, 'profiles.json')
const AVATARS_PATH  = path.join(BASE_DIR, 'src/AVATARs')
const CONFIG_PATH   = path.join(BASE_DIR, 'config.json')
const LOG_PATH      = path.join(BASE_DIR, 'jellyfin_debug.log')

/* Fichier de séquence de lancement : l'app à démarrer après que
   XeLauncher se ferme. Le script wrapper lit ce fichier. */
const LAUNCH_NEXT_FILE = '/tmp/xelauncher-launch-next'

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function logDebug(msg) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`) } catch(e) {}
  console.log(msg)
}

function ensureDirs() {
  [BASE_DIR, AVATARS_PATH].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) })
}

function loadJSON(p, def) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch(e) {}
  return def
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

function loadConfig()       { return loadJSON(CONFIG_PATH, { controllerType: 'generic' }) }
function saveConfig(data)   { saveJSON(CONFIG_PATH, data) }

function loadProfiles() {
  const data = loadJSON(PROFILES_PATH, { server: '', profiles: [] })
  if (data.profiles) data.profiles = data.profiles.map(p => ({ ...p, password: decrypt(p.password||'') }))
  return data
}

function saveProfiles(data) {
  saveJSON(PROFILES_PATH, {
    server: data.server,
    profiles: data.profiles.map(p => ({ ...p, password: encrypt(p.password||'') }))
  })
}

/* ── Window ─────────────────────────────────────────────────────────────────── */
let mainWindow = null
let powerBlockerId = null

function resolveHTML(name) {
  // Supporte deux layouts : src/HTMLs/name.html  OU  name.html à la racine
  const candidates = [
    path.join(__dirname, '..', 'HTMLs', name),
    path.join(__dirname, name),
    path.join(__dirname, '..', name),
  ]
  return candidates.find(p => fs.existsSync(p)) || candidates[0]
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width, height,
    fullscreen: true,
    frame: false,
    kiosk: true,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile(resolveHTML('menu.html'))
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus() })

  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')

  mainWindow.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload() }, 1000)
  })
}

app.whenReady().then(() => {
  ensureDirs()
  getOrCreateSecretKey()
  // Nettoyer les fichiers résiduels
  try { fs.unlinkSync(LAUNCH_NEXT_FILE) } catch(e) {}
  createWindow()
})

app.on('window-all-closed', () => {
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  // Ne PAS appeler app.quit() ici : le wrapper gère tout
})

/* ── Navigation ──────────────────────────────────────────────────────────────── */
ipcMain.handle('go-back', async () => {
  if (mainWindow) mainWindow.loadFile(resolveHTML('menu.html'))
})

ipcMain.handle('open-settings', async () => {
  if (mainWindow) mainWindow.loadFile(resolveHTML('settings.html'))
})

ipcMain.handle('save-server', async (_, serverUrl) => {
  const data = loadProfiles(); data.server = serverUrl; saveProfiles(data); return true
})

/* ── Fonction centrale : quitter Electron et lancer une commande ────────────── */
/**
 * Lance `cmd` (shell) en écrivant d'abord LAUNCH_NEXT_FILE,
 * puis quitte Electron proprement.
 * Le wrapper script lit ce fichier, attend la fin du process, puis
 * relance Electron.
 *
 * Format du fichier : première ligne = commande shell complète
 */
function handoffToExternal(cmd) {
  logDebug(`handoffToExternal: ${cmd}`)

  // Écrire la commande pour le wrapper
  fs.writeFileSync(LAUNCH_NEXT_FILE, cmd + '\n')

  // Quitter Electron — le wrapper prend le relais
  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId) } catch(e) {}
    powerBlockerId = null
  }
  app.quit()
}

/* ── Script wrapper (écrit au premier lancement si absent) ───────────────────── */
/**
 * Ce script est à déposer dans ~/xelauncher/xelauncher.sh
 * et à appeler depuis autostart / .bashrc au lieu d'appeler electron directement.
 *
 * Contenu suggéré (pour info, pas écrit automatiquement par cet handler) :
 *
 * #!/bin/bash
 * XELAUNCHER_DIR="$HOME/xelauncher"
 * LAUNCH_FILE="/tmp/xelauncher-launch-next"
 * while true; do
 *   rm -f "$LAUNCH_FILE"
 *   electron "$XELAUNCHER_DIR/src/main.js" --no-sandbox
 *   if [ -f "$LAUNCH_FILE" ]; then
 *     CMD=$(cat "$LAUNCH_FILE")
 *     rm -f "$LAUNCH_FILE"
 *     eval "$CMD"
 *   else
 *     break
 *   fi
 * done
 */

/* ── RetroArch / RetroPie ────────────────────────────────────────────────────── */
ipcMain.handle('launch-retropie', async () => {
  const emPaths = [
    '/usr/bin/emulationstation',
    '/opt/retropie/supplementary/emulationstation/emulationstation'
  ]
  const emPath = emPaths.find(p => fs.existsSync(p))

  if (!emPath) {
    logDebug('EmulationStation introuvable')
    return false
  }

  logDebug(`Lancement RetroPie : ${emPath}`)
  handoffToExternal(emPath)
  return true
})

/* ── Jellyfin ────────────────────────────────────────────────────────────────── */
ipcMain.handle('launch-jellyfin', async () => {
  // Démarrer Tailscale si disponible, puis afficher les profils
  await new Promise(resolve => {
    exec('which tailscale', err => {
      if (err) return resolve()
      exec('sudo systemctl start tailscaled 2>/dev/null', () => {
        exec('sudo tailscale up 2>/dev/null', () => resolve())
      })
    })
  })
  if (mainWindow) mainWindow.loadFile(resolveHTML('profiles.html'))
})

ipcMain.handle('launch-jellyfin-token', async (_, server, token, userId) => {
  logDebug('=== LANCEMENT JELLYFIN ===')
  logDebug(`Server: ${server}  UserId: ${userId}`)

  const url = `${server}/web/index.html#!/home?api_key=${token}&userId=${userId}`

  // 1. Chercher Jellyfin Media Player (flatpak) — option native TV
  const hasFlatpak = await new Promise(r => exec('which flatpak', e => r(!e)))
  const hasJMP = hasFlatpak && await new Promise(r =>
    exec('flatpak list --app --columns=application 2>/dev/null | grep -q com.github.iwalton3.jellyfin-media-player', e => r(!e))
  )

  if (hasJMP) {
    logDebug('Utilisation de JMP (flatpak)')

    // Pré-configurer JMP : serveur + token
    const jmpCfgDir = path.join(os.homedir(), '.var/app/com.github.iwalton3.jellyfin-media-player/config/Jellyfin Media Player')
    try {
      fs.mkdirSync(jmpCfgDir, { recursive: true })
      fs.writeFileSync(path.join(jmpCfgDir, 'jellyfinmediaplayer.conf'),
        `[General]\nwebMode=tv\nstartFullScreen=true\nignoreSSLErrors=true\n\n[Jellyfin]\nserverUrl=${server}\nuserId=${userId}\ntoken=${token}\n`)
      logDebug('Config JMP écrite')
    } catch(e) { logDebug(`Erreur config JMP: ${e.message}`) }

    handoffToExternal(`flatpak run com.github.iwalton3.jellyfin-media-player --tv --fullscreen`)
    return true
  }

  // 2. Chercher Chromium en mode kiosk
  const chromiumCmds = ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome']
  let browserCmd = null
  for (const cmd of chromiumCmds) {
    const found = await new Promise(r => exec(`which ${cmd}`, (e, o) => r(!e && !!o.trim())))
    if (found) { browserCmd = cmd; break }
  }

  if (browserCmd) {
    logDebug(`Utilisation de ${browserCmd}`)
    const args = [
      '--kiosk', '--no-first-run', '--disable-pinch', '--disable-infobars',
      '--overscroll-history-navigation=0', '--disable-features=TranslateUI',
      '--disable-session-crashed-bubble', '--disable-gpu-sandbox', '--no-sandbox',
      `--app=${url}`
    ].join(' ')
    handoffToExternal(`${browserCmd} ${args}`)
    return true
  }

  // 3. Dernier recours : ouvrir directement dans la fenêtre Electron
  // (pas de handoff, l'app reste ouverte)
  logDebug('Aucun navigateur externe trouvé — ouverture dans Electron')
  if (mainWindow) {
    mainWindow.loadURL(url)
    return true
  }

  logDebug('ÉCHEC : impossible de lancer Jellyfin')
  return false
})

/* ── Auth Jellyfin ─────────────────────────────────────────────────────────── */
ipcMain.handle('jellyfin-authenticate', async (_, server, username, password) => {
  logDebug(`Auth: ${username} → ${server}`)
  return new Promise(resolve => {
    try {
      const u    = new URL(server + '/Users/AuthenticateByName')
      const body = JSON.stringify({ Username: username, Pw: password })
      const lib  = u.protocol === 'https:' ? https : http
      const req  = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Emby-Authorization': 'MediaBrowser Client="XeLauncher", Device="RPI5", DeviceId="xelauncher-rpi5", Version="2.0.0"'
        }
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (j.AccessToken) {
              resolve({ ok: true, accessToken: j.AccessToken, userId: j.User?.Id, userName: j.User?.Name })
            } else {
              resolve({ ok: false, error: j.message || 'Authentification refusée' })
            }
          } catch(e) { resolve({ ok: false, error: 'Réponse invalide' }) }
        })
      })
      req.on('error', e => resolve({ ok: false, error: e.message }))
      req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Délai dépassé' }) })
      req.write(body); req.end()
    } catch(e) { resolve({ ok: false, error: 'URL invalide' }) }
  })
})

/* ── Profils ────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-profiles', async () => loadProfiles())

ipcMain.handle('save-profile', async (_, profile) => {
  const data = loadProfiles()
  const idx  = data.profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) data.profiles[idx] = profile; else data.profiles.push(profile)
  saveProfiles(data); return true
})

ipcMain.handle('delete-profile', async (_, id) => {
  const data = loadProfiles()
  data.profiles = data.profiles.filter(p => p.id !== id)
  saveProfiles(data); return true
})

ipcMain.handle('get-avatars', async () => {
  try { if (fs.existsSync(AVATARS_PATH)) return fs.readdirSync(AVATARS_PATH).filter(f => /\.(png|jpg|jpeg)$/i.test(f)) }
  catch(e) {}
  return []
})

ipcMain.handle('get-avatar-data', async (_, filename) => {
  try {
    if (!filename || filename.startsWith('builtin_')) return null
    const p = path.join(AVATARS_PATH, filename)
    if (!fs.existsSync(p)) return null
    const data = fs.readFileSync(p)
    const ext  = path.extname(filename).toLowerCase().replace('.','')
    return `data:image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png'};base64,${data.toString('base64')}`
  } catch(e) { return null }
})

/* ── Système ────────────────────────────────────────────────────────────────── */
ipcMain.handle('system-reboot',   async () => exec('sudo systemctl reboot'))
ipcMain.handle('system-shutdown', async () => exec('sudo systemctl poweroff'))

ipcMain.handle('system-update', async () => new Promise(resolve => {
  exec('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq',
    { timeout: 600000 }, err => resolve(!err))
}))

ipcMain.handle('get-version', async () => {
  try { return require(path.join(__dirname, 'package.json')).version } catch(e) { return '2.0.0' }
})

ipcMain.handle('check-update', async () => new Promise(resolve => {
  exec('sudo apt update -qq 2>/dev/null && apt list --upgradable 2>/dev/null | grep -vc "Listing"', (err, out) => {
    const n = parseInt(out?.trim()) || 0
    resolve({ available: n > 0, version: n + ' paquet(s)' })
  })
}))

/* ── Config ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-config',          async () => loadConfig())
ipcMain.handle('set-controller-type', async (_, type) => {
  const cfg = loadConfig(); cfg.controllerType = type; saveConfig(cfg); return true
})

/* ── Affichage ─────────────────────────────────────────────────────────────── */
ipcMain.handle('set-display', async (_, opts) => {
  const cfg = loadConfig(); cfg.display = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const res = (opts.resolution || '1920x1080').replace(/[×x×]/g,'x')
    const [w, h] = res.split('x').map(Number)
    const rate   = parseInt(opts.refresh) || 60
    const rotMap = {'0°':'normal','90°':'left','180°':'inverted','270°':'right'}
    const rot    = rotMap[opts.rotation] || 'normal'
    exec('which xrandr', err => {
      if (!err) {
        exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
          const output = (out||'').trim() || 'HDMI-1'
          exec(`xrandr --output ${output} --mode ${w}x${h} --rate ${rate} --rotate ${rot}`, e3 => resolve(!e3))
        })
      } else {
        exec(`sudo raspi-config nonint do_resolution ${w} ${h}`, e4 => resolve(!e4))
      }
    })
  })
})

/* ── Audio ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('set-audio', async (_, opts) => {
  const cfg = loadConfig(); cfg.audio = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        exec(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}%`, e => resolve(!e))
      } else {
        exec(`amixer sset Master ${vol}%`, e => resolve(!e))
      }
    })
  })
})

/* ── Réseau ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-interfaces', async () => new Promise(resolve => {
  exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const ifaces = out.trim().split('\n').filter(Boolean)
    Promise.all(ifaces.map(iface => new Promise(res => {
      iface = iface.trim()
      exec(`ip link show ${iface}`, (e1, lo) => {
        const up = /LOWER_UP/.test(lo||'') || (/[<,]UP[,>]/.test(lo||'') && !/NO-CARRIER/.test(lo||''))
        exec(`ip -4 addr show ${iface}`, (e2, ao) => {
          const m = ao && ao.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
          res({ name: iface, ip: m?m[1]:null, cidr: m?m[2]:null, state: up?'up':'down' })
        })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('get-ip-addresses', async () => {
  const getIP = iface => new Promise(r => {
    exec(`ip -4 addr show ${iface}`, (err, out) => {
      const m = out && out.match(/inet (\d+\.\d+\.\d+\.\d+)/); r(m?m[1]:null)
    })
  })
  const [wifi, eth] = await Promise.all([getIP('wlan0'), getIP('eth0')])
  return { wifi, eth }
})

ipcMain.handle('wifi-scan', async () => new Promise(resolve => {
  exec('nmcli --fields SSID,SIGNAL,SECURITY --terse dev wifi list 2>/dev/null', (err, out) => {
    if (err || !out) return resolve([])
    const seen = new Set()
    const nets = out.trim().split('\n').map(line => {
      const p = line.split(':')
      if (p.length < 3) return null
      return { ssid: p[0].trim(), signal: p[1].trim()||'0', security: p[2].trim()||'' }
    }).filter(n => { if (!n||!n.ssid||n.ssid==='--') return false; if (seen.has(n.ssid)) return false; seen.add(n.ssid); return true })
    resolve(nets)
  })
}))

ipcMain.handle('wifi-connect', async (_, ssid, pwd) => new Promise(resolve => {
  const s = ssid.replace(/'/g,"'\\''")
  const cmd = pwd ? `nmcli dev wifi connect '${s}' password '${pwd.replace(/'/g,"'\\''")}' ` : `nmcli dev wifi connect '${s}'`
  exec(cmd, err => resolve(!err))
}))

ipcMain.handle('wifi-forget', async (_, ssid) => new Promise(resolve => {
  exec(`nmcli connection delete '${ssid.replace(/'/g,"'\\''")}' `, err => resolve(!err))
}))

ipcMain.handle('wifi-current-ssid', async () => new Promise(resolve => {
  exec('nmcli -t -f NAME,TYPE connection show --active 2>/dev/null', (err, out) => {
    if (err||!out) return resolve('')
    const line = out.trim().split('\n').find(l => l.includes('wifi')||l.includes('802-11'))
    resolve(line ? line.split(':')[0] : '')
  })
}))

ipcMain.handle('set-static-ip', async (_, opts) => {
  const { iface, dhcp, ip, mask, gw, dns } = opts
  if (!iface) return false
  const cidr = (mask||'255.255.255.0').split('.').reduce((a,o) => a+(parseInt(o)>>>0).toString(2).split('1').length-1, 0)
  const dnsVal = dns || '1.1.1.1 1.0.0.1'
  const useNM = await new Promise(r => exec('systemctl is-active NetworkManager', (e,o) => r(!e&&o.trim()==='active')))
  if (!useNM) return false
  return new Promise(resolve => {
    exec('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null', (e, out) => {
      let conn = null
      if (out) { const line = out.trim().split('\n').find(l => l.endsWith(':'+iface)); if (line) conn = line.split(':')[0] }
      if (!conn) { conn = 'xelauncher-'+iface; exec(`nmcli connection delete '${conn}' 2>/dev/null`, ()=>{}) }
      const cmd = dhcp
        ? `nmcli connection modify '${conn}' ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""`
        : `nmcli connection modify '${conn}' ipv4.method manual ipv4.addresses '${ip}/${cidr}' ipv4.gateway '${gw||''}' ipv4.dns '${dnsVal}'`
      exec(cmd, err => {
        if (err) return resolve(false)
        exec(`nmcli connection up '${conn}' ifname ${iface}`, err2 => resolve(!err2))
      })
    })
  })
})

/* ── Bluetooth ──────────────────────────────────────────────────────────────── */
ipcMain.handle('bt-list-paired', async () => new Promise(resolve => {
  exec('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null', (err, out) => {
    if (err||!out.trim()) return resolve([])
    const devs = out.trim().split('\n').map(l => {
      const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m ? { mac:m[1], name:m[2].trim() } : null
    }).filter(Boolean)
    Promise.all(devs.map(d => new Promise(r => {
      exec(`bluetoothctl info ${d.mac} 2>/dev/null`, (e,o) => {
        r({ ...d, connected:/Connected: yes/.test(o||''), trusted:/Trusted: yes/.test(o||'') })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('bt-scan', async () => new Promise(resolve => {
  exec('bluetoothctl --timeout 8 scan on 2>/dev/null', () => {
    exec('bluetoothctl devices 2>/dev/null', (err, out) => {
      if (err||!out.trim()) return resolve([])
      exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
        const pairedMacs = new Set((paired||'').trim().split('\n').map(l => { const m=l.match(/Device ([0-9A-Fa-f:]{17})/); return m?m[1]:null }).filter(Boolean))
        resolve(out.trim().split('\n').map(l => { const m=l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m?{mac:m[1],name:m[2].trim(),paired:pairedMacs.has(m[1])}:null }).filter(Boolean))
      })
    })
  })
}))

ipcMain.handle('bt-pair', async (_, mac) => new Promise(resolve => {
  exec(`echo -e "pair ${mac}\ntrust ${mac}\nconnect ${mac}\nquit" | bluetoothctl 2>/dev/null`, (err, out) =>
    resolve(!err && /Pairing successful|Connected: yes|trust succeeded/i.test(out||'')))
}))

ipcMain.handle('bt-connect',    async (_, mac) => new Promise(r => exec(`bluetoothctl connect ${mac}`, (e,o) => r(!e&&/Connection successful/i.test(o||'')))))
ipcMain.handle('bt-disconnect', async (_, mac) => new Promise(r => exec(`bluetoothctl disconnect ${mac}`, e => r(!e))))
ipcMain.handle('bt-remove',     async (_, mac) => new Promise(r => exec(`bluetoothctl remove ${mac}`, e => r(!e))))

ipcMain.handle('bt-rename', async (_, mac, name) => {
  const cfg = loadConfig(); if (!cfg.btNames) cfg.btNames = {}; cfg.btNames[mac] = name; saveConfig(cfg); return true
})

ipcMain.handle('bt-status', async () => new Promise(resolve => {
  exec('bluetoothctl show 2>/dev/null', (err, out) =>
    resolve({ powered:/Powered: yes/i.test(out||''), discoverable:/Discoverable: yes/i.test(out||'') }))
}))

ipcMain.handle('bt-power', async (_, on) => new Promise(r => exec(`bluetoothctl power ${on?'on':'off'}`, e => r(!e))))
