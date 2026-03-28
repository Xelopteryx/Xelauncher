/**
 * XeLauncher — main.js
 * Electron main process
 */

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker } = require('electron')
const path = require('path')
const { exec, spawn } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')

/* ── Paths ────────────────────────────────────────────────────────────────── */
const BASE_DIR     = path.join(os.homedir(), 'xelauncher')
const PROFILES_PATH = path.join(BASE_DIR, 'profiles.json')
const AVATARS_PATH  = path.join(BASE_DIR, 'src/AVATARs')
const CONFIG_PATH   = path.join(BASE_DIR, 'config.json')

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function ensureDirs() {
  [BASE_DIR, AVATARS_PATH].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) })
}

function loadJSON(filePath, defaultVal) {
  try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch(e) {}
  return defaultVal
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function loadConfig() { return loadJSON(CONFIG_PATH, { controllerType: 'generic' }) }
function saveConfig(data) { saveJSON(CONFIG_PATH, data) }
function loadProfiles() { return loadJSON(PROFILES_PATH, { server: '', profiles: [] }) }
function saveProfiles(data) { saveJSON(PROFILES_PATH, data) }

/* ── Window ───────────────────────────────────────────────────────────────── */
let mainWindow = null
let powerBlockerId = null

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

  mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html'))
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus() })

  // Prevent display sleep
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')

  mainWindow.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (mainWindow) mainWindow.reload() }, 1000)
  })
}

app.whenReady().then(() => {
  ensureDirs()
  // Clean up retropie lock if leftover
  try { fs.unlinkSync('/tmp/xelauncher-retropie-running') } catch(e) {}
  createWindow()
})

app.on('window-all-closed', () => {
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  app.quit()
})

/* ── Navigation ───────────────────────────────────────────────────────────── */
ipcMain.handle('go-back', async () => {
  if (retroTimer) { clearTimeout(retroTimer); retroTimer = null }
  try { fs.unlinkSync('/tmp/xelauncher-retropie-running') } catch(e) {}
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html'))
})

ipcMain.handle('open-settings', async () => {
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'settings.html'))
})

/* ── RetroArch / RetroPie ─────────────────────────────────────────────────── */
let retroTimer = null

ipcMain.handle('launch-retropie', async () => {
  if (retroTimer) { clearTimeout(retroTimer); retroTimer = null }
  fs.writeFileSync('/tmp/xelauncher-retropie-running', '1')

  // Hide window so EmulationStation gets full display
  if (mainWindow) mainWindow.hide()

  // Try emulationstation or retroarch
  const emPaths = ['/usr/bin/emulationstation', '/opt/retropie/supplementary/emulationstation/emulationstation']
  const emPath = emPaths.find(p => fs.existsSync(p))

  if (!emPath) {
    fs.unlinkSync('/tmp/xelauncher-retropie-running')
    if (mainWindow) { mainWindow.show(); mainWindow.focus() }
    return false
  }

  const proc = spawn(emPath, [], { detached: true, stdio: 'ignore' })
  proc.unref()

  proc.on('close', () => {
    try { fs.unlinkSync('/tmp/xelauncher-retropie-running') } catch(e) {}
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html'))
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Fallback poll in case proc.on('close') doesn't fire
  function checkDone() {
    if (!fs.existsSync('/tmp/xelauncher-retropie-running')) {
      retroTimer = null
      if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html'))
        mainWindow.show(); mainWindow.focus()
      }
    } else {
      retroTimer = setTimeout(checkDone, 2000)
    }
  }
  retroTimer = setTimeout(checkDone, 8000)
  return true
})

/* ── Jellyfin ─────────────────────────────────────────────────────────────── */
ipcMain.handle('launch-jellyfin', async () => {
  // Go to profiles page (Tailscale started if available)
  const startTailscale = () => new Promise(resolve => {
    exec('which tailscale', (err) => {
      if (err) return resolve()
      exec('sudo systemctl start tailscaled 2>/dev/null', () => {
        exec('sudo tailscale up 2>/dev/null', () => resolve())
      })
    })
  })
  await startTailscale()
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'profiles.html'))
})

ipcMain.handle('launch-jellyfin-token', async (event, server, token, userId) => {
  if (mainWindow) mainWindow.hide()

  // Write JMP config
  const jmpConfigDir = path.join(os.homedir(), '.var/app/com.github.iwalton3.jellyfin-media-player/config/Jellyfin Media Player')
  try {
    fs.mkdirSync(jmpConfigDir, { recursive: true })
    const conf = '[General]\nwebMode=tv\nkiosk=true\nignoreSSLErrors=true\n\n[Jellyfin]\nserverUrl=' + server + '\nuserId=' + userId + '\ntoken=' + token + '\n'
    fs.writeFileSync(path.join(jmpConfigDir, 'jellyfinmediaplayer.conf'), conf)
  } catch(e) {}

  // Check flatpak
  exec('which flatpak', (err) => {
    if (err) {
      if (mainWindow) { mainWindow.show(); mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html')) }
      return
    }
    const proc = spawn('flatpak', ['run', 'com.github.iwalton3.jellyfin-media-player', '--tv', '--fullscreen'], {
      detached: true,
      env: { ...process.env, JELLYFIN_SERVER_URL: server, JELLYFIN_USER_ID: userId, JELLYFIN_TOKEN: token }
    })
    proc.unref()
    proc.on('close', () => {
      exec('sudo tailscale down 2>/dev/null', () => {})
      if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '..', 'HTMLs', 'menu.html'))
        mainWindow.show(); mainWindow.focus()
      }
    })
  })
})

/* ── Jellyfin Auth ────────────────────────────────────────────────────────── */
ipcMain.handle('jellyfin-authenticate', async (_, server, username, password) => {
  return new Promise(resolve => {
    try {
      const url = new URL(server + '/Users/AuthenticateByName')
      const body = JSON.stringify({ Username: username, Pw: password })
      const lib = url.protocol === 'https:' ? https : http
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
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
            const json = JSON.parse(data)
            if (json.AccessToken) {
              resolve({ ok: true, accessToken: json.AccessToken, userId: json.User?.Id, userName: json.User?.Name })
            } else {
              resolve({ ok: false, error: json.message || 'Authentification refusée' })
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

/* ── Profiles ─────────────────────────────────────────────────────────────── */
ipcMain.handle('get-profiles', async () => loadProfiles())

ipcMain.handle('save-profile', async (_, profile) => {
  const data = loadProfiles()
  const idx = data.profiles.findIndex(p => p.id === profile.id)
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
    const ext = path.extname(filename).toLowerCase().replace('.', '')
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png'
    return 'data:' + mime + ';base64,' + data.toString('base64')
  } catch(e) { return null }
})

/* ── System ───────────────────────────────────────────────────────────────── */
ipcMain.handle('system-reboot', async () => { exec('sudo systemctl reboot') })
ipcMain.handle('system-shutdown', async () => { exec('sudo systemctl poweroff') })

ipcMain.handle('system-update', async () => {
  return new Promise(resolve => {
    exec('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq',
      { timeout: 600000 }, (err) => resolve(!err))
  })
})

ipcMain.handle('get-version', async () => {
  try { return require('./package.json').version } catch(e) { return '2.0.0' }
})

ipcMain.handle('check-update', async () => {
  return new Promise(resolve => {
    exec('sudo apt update -qq 2>/dev/null && apt list --upgradable 2>/dev/null | grep -vc "Listing"', (err, out) => {
      const n = parseInt(out?.trim()) || 0
      resolve({ available: n > 0, version: n + ' paquet(s)' })
    })
  })
})

/* ── Config ───────────────────────────────────────────────────────────────── */
ipcMain.handle('get-config', async () => loadConfig())
ipcMain.handle('set-controller-type', async (_, type) => {
  const cfg = loadConfig(); cfg.controllerType = type; saveConfig(cfg); return true
})

/* ── Display ──────────────────────────────────────────────────────────────── */
ipcMain.handle('set-display', async (_, opts) => {
  const cfg = loadConfig(); cfg.display = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const res = (opts.resolution || '1920x1080').replace('×','x').replace('×','x')
    const [w, h] = res.split('x').map(Number)
    const rate = parseInt(opts.refresh) || 60
    const rotMap = {'0°':'normal','90°':'left','180°':'inverted','270°':'right'}
    const rot = rotMap[opts.rotation] || 'normal'
    exec('which xrandr', err => {
      if (!err) {
        exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
          const output = (out || '').trim() || 'HDMI-1'
          exec('xrandr --output ' + output + ' --mode ' + w + 'x' + h + ' --rate ' + rate + ' --rotate ' + rot,
            e3 => resolve(!e3))
        })
      } else {
        exec('sudo raspi-config nonint do_resolution ' + w + ' ' + h, e4 => resolve(!e4))
      }
    })
  })
})

/* ── Audio ────────────────────────────────────────────────────────────────── */
ipcMain.handle('set-audio', async (_, opts) => {
  const cfg = loadConfig(); cfg.audio = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        exec('pactl set-sink-volume @DEFAULT_SINK@ ' + vol + '%', e => resolve(!e))
      } else {
        exec('amixer sset Master ' + vol + '%', e => resolve(!e))
      }
    })
  })
})

/* ── Network ──────────────────────────────────────────────────────────────── */
ipcMain.handle('get-interfaces', async () => {
  return new Promise(resolve => {
    exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, out) => {
      if (err || !out.trim()) return resolve([])
      const ifaces = out.trim().split('\n').filter(Boolean)
      Promise.all(ifaces.map(iface => new Promise(res => {
        iface = iface.trim()
        exec('ip link show ' + iface, (e1, lo) => {
          const up = /LOWER_UP/.test(lo || '') || (/[<,]UP[,>]/.test(lo || '') && !/NO-CARRIER/.test(lo || ''))
          exec('ip -4 addr show ' + iface, (e2, ao) => {
            const m = ao && ao.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
            res({ name: iface, ip: m ? m[1] : null, cidr: m ? m[2] : null, state: up ? 'up' : 'down' })
          })
        })
      }))).then(resolve)
    })
  })
})

ipcMain.handle('get-ip-addresses', async () => {
  const getIP = iface => new Promise(r => {
    exec('ip -4 addr show ' + iface, (err, out) => {
      const m = out && out.match(/inet (\d+\.\d+\.\d+\.\d+)/)
      r(m ? m[1] : null)
    })
  })
  const [wifi, eth] = await Promise.all([getIP('wlan0'), getIP('eth0')])
  return { wifi, eth }
})

ipcMain.handle('wifi-scan', async () => {
  return new Promise(resolve => {
    exec('nmcli --fields SSID,SIGNAL,SECURITY --terse dev wifi list 2>/dev/null', (err, out) => {
      if (err || !out) return resolve([])
      const seen = new Set()
      const nets = out.trim().split('\n').map(line => {
        const p = line.split(':')
        if (p.length < 3) return null
        return { ssid: p[0].trim(), signal: p[1].trim() || '0', security: p[2].trim() || '' }
      }).filter(n => { if (!n || !n.ssid || n.ssid === '--') return false; if (seen.has(n.ssid)) return false; seen.add(n.ssid); return true })
      resolve(nets)
    })
  })
})

ipcMain.handle('wifi-connect', async (_, ssid, pwd) => {
  return new Promise(resolve => {
    const cmd = pwd
      ? 'nmcli dev wifi connect "' + ssid.replace(/"/g,'\\"') + '" password "' + pwd.replace(/"/g,'\\"') + '"'
      : 'nmcli dev wifi connect "' + ssid.replace(/"/g,'\\"') + '"'
    exec(cmd, (err) => resolve(!err))
  })
})

ipcMain.handle('wifi-forget', async (_, ssid) => {
  return new Promise(resolve => {
    exec('nmcli connection delete "' + ssid.replace(/"/g,'\\"') + '"', err => resolve(!err))
  })
})

ipcMain.handle('wifi-current-ssid', async () => {
  return new Promise(resolve => {
    exec('nmcli -t -f NAME,TYPE connection show --active 2>/dev/null', (err, out) => {
      if (err || !out) return resolve('')
      const line = out.trim().split('\n').find(l => l.includes('wifi') || l.includes('802-11'))
      resolve(line ? line.split(':')[0] : '')
    })
  })
})

ipcMain.handle('set-static-ip', async (_, opts) => {
  const { iface, dhcp, ip, mask, gw, dns } = opts
  if (!iface) return false
  const maskToCIDR = m => { try { return m.split('.').reduce((a, o) => a + (parseInt(o)>>>0).toString(2).split('1').length-1, 0) } catch(e) { return 24 } }
  const cidr = maskToCIDR(mask || '255.255.255.0')
  const dnsVal = dns || '1.1.1.1 1.0.0.1'

  const useNM = await new Promise(r => exec('systemctl is-active NetworkManager', (e, o) => r(!e && o.trim() === 'active')))
  if (useNM) {
    return new Promise(resolve => {
      exec('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null', (e, out) => {
        let conn = null
        if (out) { const line = out.trim().split('\n').find(l => l.endsWith(':' + iface)); if (line) conn = line.split(':')[0] }
        if (!conn) { conn = 'xelauncher-' + iface; exec('nmcli connection delete "' + conn + '" 2>/dev/null', () => {}) }
        const cmd = dhcp
          ? 'nmcli connection modify "' + conn + '" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""'
          : 'nmcli connection modify "' + conn + '" ipv4.method manual ipv4.addresses "' + ip + '/' + cidr + '" ipv4.gateway "' + (gw||'') + '" ipv4.dns "' + dnsVal + '"'
        exec(cmd, err => {
          if (err) return resolve(false)
          exec('nmcli connection up "' + conn + '" ifname ' + iface, err2 => resolve(!err2))
        })
      })
    })
  }
  return false
})

/* ── Bluetooth ────────────────────────────────────────────────────────────── */
ipcMain.handle('bt-list-paired', async () => {
  return new Promise(resolve => {
    exec('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null', (err, out) => {
      if (err || !out.trim()) return resolve([])
      const devs = out.trim().split('\n').map(l => {
        const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m ? { mac: m[1], name: m[2].trim() } : null
      }).filter(Boolean)
      Promise.all(devs.map(d => new Promise(r => {
        exec('bluetoothctl info ' + d.mac + ' 2>/dev/null', (e, o) => {
          r({ ...d, connected: /Connected: yes/.test(o||''), trusted: /Trusted: yes/.test(o||'') })
        })
      }))).then(resolve)
    })
  })
})

ipcMain.handle('bt-scan', async () => {
  return new Promise(resolve => {
    exec('bluetoothctl --timeout 8 scan on 2>/dev/null', () => {
      exec('bluetoothctl devices 2>/dev/null', (err, out) => {
        if (err || !out.trim()) return resolve([])
        exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
          const pairedMacs = new Set((paired||'').trim().split('\n').map(l => { const m=l.match(/Device ([0-9A-Fa-f:]{17})/); return m?m[1]:null }).filter(Boolean))
          const devs = out.trim().split('\n').map(l => { const m=l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m ? { mac:m[1], name:m[2].trim(), paired:pairedMacs.has(m[1]) } : null }).filter(Boolean)
          resolve(devs)
        })
      })
    })
  })
})

ipcMain.handle('bt-pair', async (_, mac) => {
  return new Promise(resolve => {
    exec('echo -e "pair ' + mac + '\ntrust ' + mac + '\nconnect ' + mac + '\nquit" | bluetoothctl 2>/dev/null', (err, out) => {
      resolve(!err && /Pairing successful|Connected: yes|trust succeeded/i.test(out||''))
    })
  })
})

ipcMain.handle('bt-connect', async (_, mac) => {
  return new Promise(resolve => { exec('bluetoothctl connect ' + mac, (err, out) => resolve(!err && /Connection successful/i.test(out||''))) })
})

ipcMain.handle('bt-disconnect', async (_, mac) => {
  return new Promise(resolve => { exec('bluetoothctl disconnect ' + mac, err => resolve(!err)) })
})

ipcMain.handle('bt-remove', async (_, mac) => {
  return new Promise(resolve => { exec('bluetoothctl remove ' + mac, err => resolve(!err)) })
})

ipcMain.handle('bt-rename', async (_, mac, name) => {
  const cfg = loadConfig(); if (!cfg.btNames) cfg.btNames = {}; cfg.btNames[mac] = name; saveConfig(cfg); return true
})

ipcMain.handle('bt-status', async () => {
  return new Promise(resolve => {
    exec('bluetoothctl show 2>/dev/null', (err, out) => {
      resolve({ powered: /Powered: yes/i.test(out||''), discoverable: /Discoverable: yes/i.test(out||'') })
    })
  })
})

ipcMain.handle('bt-power', async (_, on) => {
  return new Promise(resolve => { exec('bluetoothctl power ' + (on ? 'on' : 'off'), err => resolve(!err)) })
})
