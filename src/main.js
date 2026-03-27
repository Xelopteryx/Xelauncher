const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { exec, spawn } = require('child_process')
const http  = require('http')
const https = require('https')
const fs    = require('fs')

let mainWindow
let evdevSuspended = false  // suspend events while Retropie/JMP is running
let wiimotePythonProcess = null  // Process for wiimote_jellyfin.py
const HOME          = require('os').homedir()
const PROFILES_PATH = path.join(HOME, 'xelauncher', 'profiles.json')
const AVATARS_PATH  = path.join(HOME, 'xelauncher', 'avatars')
const CONFIG_PATH   = path.join(HOME, 'xelauncher', 'config.json')

// Repertoires JMP
const JMP_BASE   = path.join(HOME, '.var/app/com.github.iwalton3.jellyfin-media-player')
const JMP_CONFIG = path.join(JMP_BASE, 'config/Jellyfin Media Player')
const JMP_DATA   = path.join(JMP_BASE, 'data/Jellyfin Media Player')
const JMP_LS_DIR = path.join(JMP_DATA, 'QtWebEngine/Default/Local Storage/leveldb')

// ── Dossiers necessaires ──────────────────────────────────────────────────
function ensureDirectories() {
  [
    path.join(HOME, 'xelauncher'),
    AVATARS_PATH,
    JMP_CONFIG,
    JMP_DATA,
    JMP_LS_DIR,
  ].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  })
}

// ── Fenetre principale ────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width, height, fullscreen: true, frame: false, kiosk: true,
    backgroundColor: '#0a0a0f', show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'menu.html'))
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })
  mainWindow.webContents.on('crashed', () => {
    console.error('Renderer crashed, reloading')
    setTimeout(() => { if (mainWindow) mainWindow.reload() }, 1000)
  })
}

app.on('render-process-gone', (event, wc, details) => {
  console.error('Render process gone:', details.reason)
  setTimeout(() => { if (mainWindow) mainWindow.reload() }, 1000)
})
app.on('child-process-gone', (event, details) => {
  console.error('Child process gone:', details.type, details.reason)
})

app.whenReady().then(() => {
  ensureDirectories()
  try { fs.unlinkSync('/tmp/xelauncher-retropie-running') } catch(e) {}
  createWindow()
  startWiimoteWatcher()
})

app.on('will-quit', () => {
  stopWiimotePython()
})

// ── Navigation ────────────────────────────────────────────────────────────
ipcMain.handle('go-back', async () => {
  if (retroTimer) { clearTimeout(retroTimer); retroTimer = null }
  try { fs.unlinkSync('/tmp/xelauncher-retropie-running') } catch(e) {}
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'menu.html'))
})

// ── RetroPie ──────────────────────────────────────────────────────────────
let retroTimer = null

ipcMain.handle('launch-retropie', async () => {
  if (retroTimer) { clearTimeout(retroTimer); retroTimer = null }
  evdevSuspended = true
  fs.writeFileSync('/tmp/xelauncher-retropie-running', '1')
  const emulationStationPath = '/usr/bin/emulationstation'
  if (fs.existsSync(emulationStationPath)) {
    spawn('/bin/bash', [emulationStationPath], { detached: true, stdio: 'ignore' }).unref()
  } else {
    console.error('EmulationStation not found')
    fs.unlinkSync('/tmp/xelauncher-retropie-running')
    return
  }
  function checkDone() {
    if (!fs.existsSync('/tmp/xelauncher-retropie-running')) {
      retroTimer = null
      evdevSuspended = false
      if (mainWindow) { mainWindow.loadFile(path.join(__dirname, 'menu.html')); mainWindow.focus() }
    } else {
      retroTimer = setTimeout(checkDone, 1000)
    }
  }
  retroTimer = setTimeout(checkDone, 5000)
})

// ── Jellyfin : page profils (avec Tailscale) ──────────────────────────────
ipcMain.handle('launch-jellyfin', async () => {
  exec('which tailscale', (err) => {
    if (err) {
      if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'profiles.html'))
      return
    }
    exec('sudo systemctl start tailscaled', () => {
      exec('sudo tailscale up', () => {
        waitForTailscale(() => {
          if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'profiles.html'))
        })
      })
    })
  })
})

// ── Jellyfin : lancement JMP avec token ──────────────────────────────────
ipcMain.handle('launch-jellyfin-token', async (event, server, token, userId, serverId) => {
  evdevSuspended = true
  if (mainWindow) mainWindow.hide()

  // 1. Config JMP mode TV
  try {
    fs.mkdirSync(JMP_CONFIG, { recursive: true })
    const ini = '[General]\nwebMode=tv\nignoreSSLErrors=true\n\n[main]\nfullscreen=true\n'
    fs.writeFileSync(path.join(JMP_CONFIG, 'jellyfinmediaplayer.ini'), ini)
  } catch(e) {
    console.error('JMP ini write error:', e)
  }

  // 2. Mapping manette SDL2 (gamecontrollerdb.txt)
  writeGamepadMapping()

  // 3. Injecter les credentials dans le localStorage LevelDB de JMP
  const injectScript = path.join(__dirname, 'inject-jellyfin-credentials.js')

  const doInject = (callback) => {
    if (!fs.existsSync(injectScript)) {
      console.warn('inject script not found, skipping')
      return callback()
    }
    const sid = serverId || userId || 'xelauncher'
    const cmd = `node "${injectScript}" "${server}" "${sid}" "${token}" "${userId}"`
    exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
      if (stdout) console.log('inject stdout:', stdout.trim())
      if (stderr) console.error('inject stderr:', stderr.trim())
      if (err)    console.error('inject error:', err.message)
      callback()
    })
  }

  doInject(() => {
    exec('which flatpak', (err) => {
      if (err) {
        console.error('Flatpak not found')
        stopWiimotePython()
        if (mainWindow) { mainWindow.loadFile(path.join(__dirname, 'menu.html')); mainWindow.show() }
        return
      }
      launchJMP(server, token, userId)
    })
  })
})

// ── Lancer JMP ────────────────────────────────────────────────────────────
function launchJMP(server, token, userId) {
  const args = [
    'run',
    '--device=all',
    'com.github.iwalton3.jellyfin-media-player',
    '--fullscreen',
    '--tv',
  ]

  const env = {
    ...process.env,
    DISPLAY:               process.env.DISPLAY || ':0',
    JELLYFIN_SERVER_URL:   server,
    JELLYFIN_ACCESS_TOKEN: token,
    JELLYFIN_USER_ID:      userId || '',
    // SDL2 : indiquer le fichier de mapping manette
    SDL_GAMECONTROLLERCONFIG_FILE: path.join(JMP_CONFIG, 'gamecontrollerdb.txt'),
  }

  console.log('Launching JMP:', args.slice(2).join(' '))

  // Lancer le script Python pour la Wiimote
  startWiimotePython()

  const proc = spawn('flatpak', args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  proc.stdout.on('data', d => console.log('JMP:', d.toString().trim()))
  proc.stderr.on('data', d => console.error('JMP err:', d.toString().trim()))

  proc.on('close', (code) => {
    console.log('JMP closed, code:', code)
    // Arrêter le script Python quand JMP se ferme
    stopWiimotePython()
    evdevSuspended = false
    exec('sudo tailscale down 2>/dev/null', () => {})
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, 'menu.html'))
      mainWindow.show()
      mainWindow.focus()
    }
  })

  proc.on('error', (err) => {
    console.error('JMP spawn error:', err)
    stopWiimotePython()
    if (mainWindow) { mainWindow.loadFile(path.join(__dirname, 'menu.html')); mainWindow.show() }
  })
}

// ── Fonctions pour gérer le script Python Wiimote ────────────────────────
function startWiimotePython() {
  // Vérifier si le script existe
  const scriptPath = path.join(__dirname, 'wiimote_jellyfin.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn('wiimote_jellyfin.py not found at:', scriptPath)
    return
  }
  
  // Arrêter une instance précédente si elle existe
  stopWiimotePython()
  
  // Lancer le script Python avec sudo
  console.log('Starting wiimote_jellyfin.py...')
  wiimotePythonProcess = spawn('sudo', ['python3', scriptPath], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  
  wiimotePythonProcess.stdout.on('data', (data) => {
    console.log('[Wiimote Python]:', data.toString().trim())
  })
  
  wiimotePythonProcess.stderr.on('data', (data) => {
    console.error('[Wiimote Python error]:', data.toString().trim())
  })
  
  wiimotePythonProcess.on('close', (code) => {
    console.log('[Wiimote Python] process closed with code:', code)
    wiimotePythonProcess = null
  })
  
  wiimotePythonProcess.on('error', (err) => {
    console.error('[Wiimote Python] failed to start:', err)
    wiimotePythonProcess = null
  })
}

function stopWiimotePython() {
  if (wiimotePythonProcess) {
    console.log('Stopping wiimote_jellyfin.py...')
    try {
      // Envoyer SIGTERM pour une fermeture propre
      wiimotePythonProcess.kill('SIGTERM')
      // Donner un peu de temps pour la fermeture propre
      setTimeout(() => {
        if (wiimotePythonProcess && !wiimotePythonProcess.killed) {
          console.log('Force killing wiimote_jellyfin.py...')
          wiimotePythonProcess.kill('SIGKILL')
        }
      }, 2000)
    } catch (err) {
      console.error('Error stopping wiimote Python process:', err)
    }
    wiimotePythonProcess = null
  }
}

// ── Mapping manette SDL2 pour JMP ─────────────────────────────────────────
function writeGamepadMapping() {
  try {
    fs.mkdirSync(JMP_CONFIG, { recursive: true })
    const gcdbPath = path.join(JMP_CONFIG, 'gamecontrollerdb.txt')
    const mappings = [
      // DualShock 4 USB
      '030000004c050000c405000000000000,PS4 Controller,a:b1,b:b2,back:b8,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b4,leftstick:b10,lefttrigger:a3,leftx:a0,lefty:a1,rightshoulder:b5,rightstick:b11,righttrigger:a4,rightx:a2,righty:a5,start:b9,touchpad:b13,x:b0,y:b3,platform:Linux,',
      // DualShock 4 Bluetooth
      '050000004c050000c405000000800000,PS4 Controller,a:b1,b:b2,back:b8,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b4,leftstick:b10,lefttrigger:a3,leftx:a0,lefty:a1,rightshoulder:b5,rightstick:b11,righttrigger:a4,rightx:a2,righty:a5,start:b9,touchpad:b13,x:b0,y:b3,platform:Linux,',
      // DualSense USB
      '030000004c050000e60c000000000000,DualSense,a:b1,b:b2,back:b8,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b4,leftstick:b10,lefttrigger:a3,leftx:a0,lefty:a1,rightshoulder:b5,rightstick:b11,righttrigger:a4,rightx:a2,righty:a5,start:b9,touchpad:b13,x:b0,y:b3,platform:Linux,',
      // DualSense Bluetooth
      '050000004c050000e60c000000800000,DualSense,a:b1,b:b2,back:b8,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b4,leftstick:b10,lefttrigger:a3,leftx:a0,lefty:a1,rightshoulder:b5,rightstick:b11,righttrigger:a4,rightx:a2,righty:a5,start:b9,touchpad:b13,x:b0,y:b3,platform:Linux,',
    ]
    fs.writeFileSync(gcdbPath, mappings.join('\n') + '\n')
    console.log('Gamepad mapping written:', gcdbPath)
  } catch(e) {
    console.error('Gamepad mapping error:', e)
  }
}

// ── Tailscale helper ──────────────────────────────────────────────────────
function waitForTailscale(callback, attempts) {
  attempts = attempts || 0
  if (attempts > 20) { callback(false); return }
  exec('tailscale status --json', (err, stdout) => {
    try {
      if (stdout && JSON.parse(stdout).BackendState === 'Running') { callback(true); return }
    } catch(e) {}
    setTimeout(() => waitForTailscale(callback, attempts + 1), 1000)
  })
}

// ── Systeme ───────────────────────────────────────────────────────────────
ipcMain.handle('system-update', async () => {
  return new Promise((resolve) => {
    exec('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq', { timeout: 600000 }, (err, stdout, stderr) => {
      console.log('system-update stdout:', stdout)
      if (stderr) console.error('system-update stderr:', stderr)
      resolve(!err)
    })
  })
})

ipcMain.handle('system-reboot',   async () => { exec('sudo systemctl reboot',   (err) => { if (err) console.error('Reboot error:', err) }) })
ipcMain.handle('system-shutdown', async () => { exec('sudo systemctl poweroff', (err) => { if (err) console.error('Shutdown error:', err) }) })

ipcMain.handle('get-version', async () => {
  const pkg = path.join(__dirname, 'package.json')
  try {
    if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '1.0.0'
    return '1.0.0'
  } catch(e) { return '1.0.0' }
})

ipcMain.handle('check-update', async () => {
  return new Promise((resolve) => {
    exec('sudo apt update -qq 2>/dev/null && apt list --upgradable 2>/dev/null | grep -v "Listing" | wc -l', (err, stdout) => {
      if (err) return resolve({ available: false })
      const count = parseInt(stdout.trim()) || 0
      resolve({ available: count > 0, version: count + ' paquet(s)' })
    })
  })
})

ipcMain.handle('open-settings', async () => {
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'settings.html'))
})

// ── Gamepad Tester ────────────────────────────────────────────────────────
let gpTesterWindow = null
ipcMain.handle('open-gamepad-tester', async () => {
  if (gpTesterWindow && !gpTesterWindow.isDestroyed()) {
    gpTesterWindow.focus()
    return
  }
  gpTesterWindow = new BrowserWindow({
    width: 1280, height: 720,
    frame: true, kiosk: false, fullscreen: false,
    backgroundColor: '#0a0a0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  gpTesterWindow.loadURL('https://gamepad-tester.com')
  gpTesterWindow.on('closed', () => { gpTesterWindow = null })
})

// ── WiFi ──────────────────────────────────────────────────────────────────
ipcMain.handle('wifi-scan', async () => {
  return new Promise((resolve) => {
    exec('nmcli --fields SSID,SIGNAL,SECURITY --terse dev wifi list 2>/dev/null', (err, stdout) => {
      if (err || !stdout) return resolve([])
      const seen = new Set()
      const networks = stdout.trim().split('\n').map(line => {
        const parts = line.split(':')
        if (parts.length < 3) return null
        return { ssid: parts[0].trim(), signal: parts[1].trim() || '0', security: parts[2].trim() || 'Ouvert' }
      }).filter(n => {
        if (!n || !n.ssid || n.ssid === '--') return false
        if (seen.has(n.ssid)) return false
        seen.add(n.ssid)
        return true
      })
      resolve(networks)
    })
  })
})

ipcMain.handle('wifi-connect', async (_, ssid, password) => {
  return new Promise((resolve) => {
    const cmd = password
      ? `nmcli dev wifi connect "${ssid.replace(/"/g, '\\"')}" password "${password.replace(/"/g, '\\"')}"`
      : `nmcli dev wifi connect "${ssid.replace(/"/g, '\\"')}"`
    exec(cmd, (err, stdout, stderr) => {
      if (err) { console.error('WiFi connect error:', stderr); resolve(false) }
      else resolve(true)
    })
  })
})

ipcMain.handle('wifi-forget', async (_, ssid) => {
  return new Promise((resolve) => {
    exec(`nmcli connection delete "${ssid.replace(/"/g, '\\"')}"`, (err) => resolve(!err))
  })
})

ipcMain.handle('wifi-current-ssid', async () => {
  return new Promise((resolve) => {
    exec('nmcli -t -f NAME,TYPE connection show --active 2>/dev/null', (err, stdout) => {
      if (err || !stdout) return resolve('')
      const lines    = stdout.trim().split('\n')
      const wifiLine = lines.find(l => l.includes('wifi') || l.includes('802-11'))
      resolve(wifiLine ? wifiLine.split(':')[0] : '')
    })
  })
})

// ── Profils / Avatars ─────────────────────────────────────────────────────
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'))
    return { server: 'http://192.168.1.100:8096', profiles: [] }
  } catch(e) {
    return { server: 'http://192.168.1.100:8096', profiles: [] }
  }
}

function saveProfiles(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2))
}

ipcMain.handle('get-profiles', async () => loadProfiles())

ipcMain.handle('save-profile', async (_, profile) => {
  const data = loadProfiles()
  const idx  = data.profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) data.profiles[idx] = profile
  else data.profiles.push(profile)
  saveProfiles(data)
  return true
})

ipcMain.handle('delete-profile', async (_, id) => {
  const data = loadProfiles()
  data.profiles = data.profiles.filter(p => p.id !== id)
  saveProfiles(data)
  return true
})

ipcMain.handle('get-avatars', async () => {
  try {
    if (fs.existsSync(AVATARS_PATH)) return fs.readdirSync(AVATARS_PATH).filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    return []
  } catch(e) { return [] }
})

ipcMain.handle('get-avatar-data', async (_, filename) => {
  try {
    if (filename.startsWith('builtin_')) return null
    const avatarPath = path.join(AVATARS_PATH, filename)
    if (!fs.existsSync(avatarPath)) return null
    const data = fs.readFileSync(avatarPath)
    const ext  = path.extname(filename).toLowerCase().replace('.', '')
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch(e) { return null }
})

// ── Config ────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return { controllerType: 'psn' }
  } catch(e) { return { controllerType: 'psn' } }
}

function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2))
}

ipcMain.handle('get-config', async () => loadConfig())

ipcMain.handle('set-controller-type', async (_, type) => {
  const config = loadConfig()
  config.controllerType = type
  saveConfig(config)
  return true
})

// ── Reseau avance ─────────────────────────────────────────────────────────
ipcMain.handle('get-interfaces', async () => {
  return new Promise((resolve) => {
    exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, stdout) => {
      if (err) return resolve([])
      const all = stdout.trim().split('\n').filter(n => n && n.trim())
      Promise.all(all.map(iface => new Promise(res => {
        exec(`ip link show ${iface.trim()} 2>/dev/null`, (e1, linkOut) => {
          const hasLowerUp   = /LOWER_UP/.test(linkOut || '')
          const hasUp        = /[<,]UP[,>]/.test(linkOut || '')
          const hasNoCarrier = /NO-CARRIER/.test(linkOut || '')
          const state        = (hasLowerUp || (hasUp && !hasNoCarrier)) ? 'up' : 'down'
          exec(`ip -4 addr show ${iface.trim()} 2>/dev/null`, (e2, addrOut) => {
            const m = addrOut && addrOut.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
            res({ name: iface.trim(), ip: m ? m[1] : null, cidr: m ? m[2] : null, state })
          })
        })
      }))).then(resolve)
    })
  })
})

ipcMain.handle('get-ip-addresses', async () => {
  function getIP(iface) {
    return new Promise((resolve) => {
      exec(`ip -4 addr show ${iface} 2>/dev/null`, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const match = stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/)
        resolve(match ? match[1] : null)
      })
    })
  }
  const [wifi, eth] = await Promise.all([getIP('wlan0'), getIP('eth0')])
  return { wifi, eth }
})

ipcMain.handle('set-display', async (_, opts) => {
  const config = loadConfig()
  config.display = { resolution: opts.resolution, refresh: opts.refresh, rotation: opts.rotation, overscan: opts.overscan }
  saveConfig(config)
  return new Promise((resolve) => {
    const res = (opts.resolution || '1920x1080').replace(/[^\dx]/g, 'x').replace('xx', 'x')
    const [w, h] = res.split('x').map(Number)
    const rate   = parseInt(opts.refresh) || 60
    const rotMap = { '0': 'normal', '90': 'left', '180': 'inverted', '270': 'right' }
    const rotKey = String(parseInt(opts.rotation) || 0)
    const rot    = rotMap[rotKey] || 'normal'
    exec('which xrandr', (err) => {
      if (!err) {
        exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e2, out) => {
          const output = (out || '').trim() || 'HDMI-1'
          exec(`xrandr --output ${output} --mode ${w}x${h} --rate ${rate} --rotate ${rot}`, (e3) => resolve(!e3))
        })
      } else {
        exec(`sudo raspi-config nonint do_resolution ${w} ${h}`, (e4) => resolve(!e4))
      }
    })
  })
})

ipcMain.handle('set-audio', async (_, opts) => {
  const config = loadConfig()
  config.audio = { output: opts.output, volume: opts.volume }
  saveConfig(config)
  return new Promise((resolve) => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        exec('pactl list short sinks', (e2, sinksOut) => {
          const sinks = (sinksOut || '').trim().split('\n').map(l => l.split('\t')[1]).filter(Boolean)
          let targetSink = '@DEFAULT_SINK@'
          if (opts.output === 'HDMI')            targetSink = sinks.find(s => /hdmi/i.test(s))    || '@DEFAULT_SINK@'
          else if (opts.output === 'Analogique') targetSink = sinks.find(s => /analog/i.test(s)) || '@DEFAULT_SINK@'
          if (targetSink !== '@DEFAULT_SINK@') exec('pactl set-default-sink "' + targetSink + '"', () => {})
          exec('pactl set-sink-volume @DEFAULT_SINK@ ' + vol + '%', (errVol) => resolve(!errVol))
        })
      } else {
        exec('amixer sset Master ' + vol + '%', (errVol) => resolve(!errVol))
      }
    })
  })
})

ipcMain.handle('set-static-ip', async (_, opts) => {
  const { iface, dhcp, ip, mask, gw } = opts
  if (!iface) return false

  const maskToCIDR = (m) => {
    try { return m.split('.').reduce((a, o) => a + (parseInt(o) >>> 0).toString(2).split('1').length - 1, 0) }
    catch(e) { return 24 }
  }
  const cidr   = maskToCIDR(mask || '255.255.255.0')
  const dnsVal = opts.dns || '1.1.1.1 1.0.0.1'

  const useNM = await new Promise(r => {
    exec('systemctl is-active NetworkManager', (e, out) => r(!e && out.trim() === 'active'))
  })
  const useDhcpcd = await new Promise(r => {
    exec('systemctl is-active dhcpcd', (e, out) => r(!e && out.trim() === 'active'))
  })

  if (useNM) {
    return new Promise((resolve) => {
      exec(`nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null`, (e, out) => {
        let connName = null
        if (out) {
          const line = out.trim().split('\n').find(l => l.endsWith(':' + iface))
          if (line) connName = line.split(':')[0]
        }
        if (!connName) {
          connName = 'xelauncher-' + iface
          exec(`nmcli connection delete "${connName}" 2>/dev/null`, () => {})
        }
        const cmds = []
        if (dhcp) {
          cmds.push(`nmcli connection modify "${connName}" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""`)
        } else {
          if (!ip) return resolve(false)
          cmds.push(`nmcli connection modify "${connName}" ipv4.method manual ipv4.addresses "${ip}/${cidr}" ipv4.gateway "${gw || ''}" ipv4.dns "${dnsVal}"`)
        }
        cmds.push(`nmcli connection up "${connName}" ifname ${iface}`)
        const runNext = (idx) => {
          if (idx >= cmds.length) return resolve(true)
          exec(cmds[idx], (err) => {
            if (err) { console.error('NM cmd error:', err); return resolve(false) }
            runNext(idx + 1)
          })
        }
        runNext(0)
      })
    })
  } else if (useDhcpcd) {
    return new Promise((resolve) => {
      const confPath = '/etc/dhcpcd.conf'
      let conf = ''
      try { conf = fs.readFileSync(confPath, 'utf8') } catch(e) { conf = '' }
      const lines    = conf.split('\n')
      const filtered = []
      let skip = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === 'interface ' + iface) { skip = true; continue }
        if (skip && line.trim().startsWith('interface ')) skip = false
        if (!skip) filtered.push(line)
      }
      conf = filtered.join('\n').trimEnd()
      if (!dhcp) {
        if (!ip) return resolve(false)
        conf += '\n\ninterface ' + iface +
                '\nstatic ip_address=' + ip + '/' + cidr +
                '\nstatic routers=' + (gw || '') +
                '\nstatic domain_name_servers=' + dnsVal + '\n'
      }
      const tmpPath = require('os').tmpdir() + '/dhcpcd_' + Date.now() + '.conf'
      try { fs.writeFileSync(tmpPath, conf) } catch(e) { return resolve(false) }
      exec(`sudo cp "${tmpPath}" ${confPath}`, (errCp) => {
        try { fs.unlinkSync(tmpPath) } catch(e) {}
        if (errCp) { console.error('dhcpcd write error:', errCp); return resolve(false) }
        exec('sudo systemctl restart dhcpcd', (errR) => {
          if (errR) console.error('dhcpcd restart error:', errR)
          resolve(!errR)
        })
      })
    })
  } else {
    console.error('set-static-ip: aucun gestionnaire reseau actif')
    return false
  }
})

// ── Jellyfin auth (HTTP depuis le process principal) ──────────────────────
ipcMain.handle('jellyfin-authenticate', async (_, server, username, password) => {
  return new Promise((resolve) => {
    try {
      const url     = new URL(server + '/Users/AuthenticateByName')
      const body    = JSON.stringify({ Username: username, Pw: password })
      const lib     = url.protocol === 'https:' ? https : http
      const options = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Emby-Authorization': 'MediaBrowser Client="XeLauncher", Device="RPI5", DeviceId="xelauncher-rpi5", Version="1.0.0"'
        }
      }
      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.AccessToken) {
              resolve({
                ok:          true,
                accessToken: json.AccessToken,
                userId:      json.User     ? json.User.Id     : null,
                userName:    json.User     ? json.User.Name   : '',
                serverId:    json.ServerId || null
              })
            } else {
              resolve({ ok: false, error: json.message || "Erreur d'authentification" })
            }
          } catch(e) {
            resolve({ ok: false, error: 'Reponse invalide du serveur' })
          }
        })
      })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Delai depasse (10s)' }) })
      req.write(body)
      req.end()
    } catch(e) {
      resolve({ ok: false, error: 'URL invalide' })
    }
  })
})

// ── Bluetooth ─────────────────────────────────────────────────────────────
ipcMain.handle('bt-list-paired', async () => {
  return new Promise((resolve) => {
    exec('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null', (err, stdout) => {
      if (err || !stdout.trim()) return resolve([])
      const devices = stdout.trim().split('\n').map(line => {
        const m = line.match(/Device ([0-9A-Fa-f:]{17}) (.+)/)
        if (!m) return null
        return { mac: m[1], name: m[2].trim() }
      }).filter(Boolean)
      Promise.all(devices.map(dev => new Promise(res => {
        exec('bluetoothctl info ' + dev.mac + ' 2>/dev/null', (e, out) => {
          const connected = /Connected: yes/.test(out || '')
          const trusted   = /Trusted: yes/.test(out || '')
          const type      = out && out.match(/Icon: (.+)/)?.[1]?.trim() || 'device'
          res({ ...dev, connected, trusted, type })
        })
      }))).then(resolve)
    })
  })
})

ipcMain.handle('bt-scan', async () => {
  return new Promise((resolve) => {
    const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let resolved = false
    const done = (out) => {
      if (resolved) return
      resolved = true
      const seen = new Set()
      const devices = []
      const re = /Device ([0-9A-Fa-f:]{17}) (.+)/g
      let m
      while ((m = re.exec(out)) !== null) {
        const mac = m[1], name = m[2].trim()
        if (!seen.has(mac)) { seen.add(mac); devices.push({ mac, name }) }
      }
      exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
        const pairedMacs = new Set((paired || '').trim().split('\n').map(l => {
          const pm = l.match(/Device ([0-9A-Fa-f:]{17})/)
          return pm ? pm[1] : null
        }).filter(Boolean))
        resolve(devices.map(d => ({ ...d, paired: pairedMacs.has(d.mac) })))
      })
    }

    proc.stdout.on('data', d => { output += d.toString() })
    proc.stderr.on('data', d => { output += d.toString() })
    const send = (cmd) => { try { proc.stdin.write(cmd + '\n') } catch(e) {} }

    send('agent on')
    send('default-agent')
    send('scan on')

    setTimeout(() => {
      send('scan off')
      setTimeout(() => {
        send('devices')
        setTimeout(() => {
          send('quit')
          setTimeout(() => {
            try { proc.stdin.end() } catch(e) {}
            try { proc.kill() } catch(e) {}
          }, 3000)
        }, 800)
      }, 800)
    }, 8000)

    proc.on('close', () => done(output))

    // Timeout de securite absolu : resoudre quoi qu'il arrive apres 15s
    setTimeout(() => {
      try { proc.stdin.end() } catch(e) {}
      try { proc.kill() } catch(e) {}
      done(output)
    }, 15000)
  })
})

ipcMain.handle('bt-pair', async (_, mac) => {
  return new Promise((resolve) => {
    const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', d => { output += d.toString() })
    proc.stderr.on('data', d => { output += d.toString() })
    const send = (cmd) => { try { proc.stdin.write(cmd + '\n') } catch(e) {} }
    let resolved = false
    const done = (ok) => {
      if (resolved) return
      resolved = true
      resolve(ok)
    }

    // Agent NoInputNoOutput = accepte automatiquement sans PIN
    send('agent off')
    send('agent NoInputNoOutput')
    send('default-agent')

    setTimeout(() => {
      send('pair ' + mac)

      const checkInterval = setInterval(() => {
        if (/Pairing successful/i.test(output)) {
          clearInterval(checkInterval)
          clearTimeout(pairTimeout)
          send('trust ' + mac)
          setTimeout(() => {
            send('connect ' + mac)
            setTimeout(() => { send('quit'); setTimeout(() => { try{proc.stdin.end()}catch(e){} done(true) }, 1000) }, 3000)
          }, 500)
        } else if (/Failed to pair|org\.bluez\.Error|not available/i.test(output)) {
          clearInterval(checkInterval)
          clearTimeout(pairTimeout)
          send('quit')
          setTimeout(() => { try{proc.stdin.end()}catch(e){} done(false) }, 500)
        }
      }, 400)

      const pairTimeout = setTimeout(() => {
        clearInterval(checkInterval)
        const failed = /Failed|Error|not available/i.test(output)
        if (!failed) {
          send('trust ' + mac)
          send('connect ' + mac)
        }
        send('quit')
        setTimeout(() => { try{proc.stdin.end()}catch(e){} done(!failed) }, 2000)
      }, 20000)

    }, 800)

    proc.on('error', (err) => {
      console.error('bt-pair proc error:', err)
      done(false)
    })

    setTimeout(() => { try{proc.stdin.end()}catch(e){} done(false) }, 28000)
  })
})


ipcMain.handle('bt-connect',    async (_, mac) => new Promise(resolve => exec('bluetoothctl connect '    + mac + ' 2>/dev/null', (err, stdout) => resolve(!err && /Connection successful|Connected: yes/i.test(stdout || '')))))
ipcMain.handle('bt-disconnect', async (_, mac) => new Promise(resolve => exec('bluetoothctl disconnect ' + mac + ' 2>/dev/null', (err) => resolve(!err))))
ipcMain.handle('bt-remove',     async (_, mac) => new Promise(resolve => exec('bluetoothctl remove '     + mac + ' 2>/dev/null', (err) => resolve(!err))))

ipcMain.handle('bt-rename', async (_, mac, name) => {
  const config = loadConfig()
  if (!config.btNames) config.btNames = {}
  config.btNames[mac] = name
  saveConfig(config)
  return true
})

ipcMain.handle('bt-status', async () => {
  return new Promise((resolve) => {
    exec('bluetoothctl show 2>/dev/null', (err, stdout) => {
      resolve({
        powered:      /Powered: yes/i.test(stdout || ''),
        discoverable: /Discoverable: yes/i.test(stdout || '')
      })
    })
  })
})

ipcMain.handle('bt-power', async (_, on) => {
  return new Promise((resolve) => {
    exec('bluetoothctl power ' + (on ? 'on' : 'off') + ' 2>/dev/null', (err) => resolve(!err))
  })
})

// ── Gamepad maps ─────────────────────────────────────────────────────────────
const INPUTMAPS_PATH = path.join(HOME, '.var/app/com.github.iwalton3.jellyfin-media-player/data/jellyfinmediaplayer/inputmaps')
const EXAMPLES_PATH  = path.join(INPUTMAPS_PATH, 'examples')

ipcMain.handle('list-gamepad-maps', async () => {
  try {
    if (!fs.existsSync(INPUTMAPS_PATH)) return []
    const files = fs.readdirSync(INPUTMAPS_PATH).filter(f => f.endsWith('.json'))
    return files.map(file => {
      try {
        const raw = fs.readFileSync(path.join(INPUTMAPS_PATH, file), 'utf8')
        const nameM    = raw.match(/"name"\s*:\s*"([^"]+)"/)
        const matcherM = raw.match(/"idmatcher"\s*:\s*"([^"]+)"/)
        return { file, name: nameM ? nameM[1] : file, idmatcher: matcherM ? matcherM[1] : '' }
      } catch(e) { return { file, name: file, idmatcher: '' } }
    })
  } catch(e) { return [] }
})

ipcMain.handle('save-gamepad-map', async (_, filename, content) => {
  try {
    fs.mkdirSync(INPUTMAPS_PATH, { recursive: true })
    const safeName = path.basename(filename)
    fs.writeFileSync(path.join(INPUTMAPS_PATH, safeName), content, 'utf8')
    return true
  } catch(e) { console.error('save-gamepad-map error:', e); return false }
})

ipcMain.handle('delete-gamepad-map', async (_, filename) => {
  try {
    const safeName = path.basename(filename)
    const filePath = path.join(INPUTMAPS_PATH, safeName)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return true
  } catch(e) { console.error('delete-gamepad-map error:', e); return false }
})

ipcMain.handle('activate-gamepad-examples', async () => {
  try {
    if (!fs.existsSync(EXAMPLES_PATH)) return false
    fs.mkdirSync(INPUTMAPS_PATH, { recursive: true })
    const examples = ['xbox-controller-linux.json', 'cec.json', 'apple-remote.json', 'apple-media-keys.json']
    examples.forEach(f => {
      const src = path.join(EXAMPLES_PATH, f)
      const dst = path.join(INPUTMAPS_PATH, f)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst)
    })
    return true
  } catch(e) { console.error('activate-gamepad-examples error:', e); return false }
})

// ── Wiimote / manette Nintendo via evdev ─────────────────────────────────────
// L'API Gamepad de Chromium n'expose pas la croix directionnelle de la Wiimote.
// On lit /dev/input/eventX directement et on envoie les events au renderer via IPC.
//
// struct input_event 64-bit Linux : timeval(16) + type(2) + code(2) + value(4) = 24 octets

const EVDEV_KEYS = {
  EV_KEY:    0x0001,
  EV_ABS:    0x0003,
  // Wiimote EV_KEY codes
  KEY_UP:    103,   KEY_DOWN:  108,  KEY_LEFT: 105,  KEY_RIGHT: 106,
  BTN_SOUTH: 304,   BTN_EAST:  305,
  BTN_1:     257,   BTN_2:     258,
  KEY_NEXT:  407,   KEY_PREV:  412,
  BTN_MODE:  316,
  // HAT D-pad (PS4, Xbox, etc.) — EV_ABS codes
  ABS_HAT0X: 16,    // -1=left, +1=right
  ABS_HAT0Y: 17,    // -1=up,   +1=down
}

// Map eventNode → process de lecture
const wiimoteReaders = new Map()

// Trouver les nœuds evdev pertinents :
// - Nintendo Wii Remote principal (boutons + croix EV_KEY)
// - Manettes avec HAT D-pad (PS4, Xbox) — repérées par ABS_HAT0X dans leurs capacités
function findGamepadNodes(cb) {
  fs.readFile('/proc/bus/input/devices', 'utf8', (err, devs) => {
    const nodes = []
    if (err || !devs) { cb(nodes); return }
    const blocks = devs.split(/\n\n+/)
    for (const block of blocks) {
      const nameM = block.match(/N: Name="([^"]+)"/)
      if (!nameM) continue
      const name = nameM[1]
      const hm = block.match(/Handlers=[^\n]*(event\d+)/)
      if (!hm) continue
      const node = '/dev/input/' + hm[1]

      // Wiimote principal
      if (/nintendo wii remote$/i.test(name)) {
        nodes.push({ node, type: 'wiimote' })
        continue
      }
      // Manettes avec HAT (PS4, Xbox, génériques) — chercher js* dans Handlers
      // et ABS=... contenant le bit HAT0X (bit 16 = 0x10 dans le champ ABS)
      if (/Handlers=[^\n]*js\d+/.test(block)) {
        const absM = block.match(/B: ABS=([0-9a-f]+)/)
        if (absM) {
          // ABS_HAT0X = bit 16 (0x10000) dans le bitmask ABS
          const absBits = BigInt('0x' + absM[1])
          if (absBits & BigInt(0x10000)) {
            nodes.push({ node, type: 'hat' })
          }
        }
      }
    }
    cb(nodes)
  })
}

// Alias pour la compatibilité
function findNintendoNodes(cb) {
  findGamepadNodes(entries => cb(entries.filter(e => e.type === 'wiimote').map(e => e.node)))
}

function spawnEvdevReader(eventNode, deviceType) {
  if (wiimoteReaders.has(eventNode)) return  // déjà en cours

  let canRead = false
  try { fs.accessSync(eventNode, fs.constants.R_OK); canRead = true } catch(e) {}

  const cmd  = canRead ? 'cat'  : 'sudo'
  const args = canRead ? [eventNode] : ['cat', eventNode]
  console.log('[evdev] lecture de', eventNode, '('+deviceType+')', canRead ? '(direct)' : '(sudo)')

  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  wiimoteReaders.set(eventNode, proc)

  if (proc.stderr) proc.stderr.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.error('[evdev] stderr:', msg)
  })

  let buf = Buffer.alloc(0)
  proc.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 24) {
      const type  = buf.readUInt16LE(16)
      const code  = buf.readUInt16LE(18)
      const value = buf.readInt32LE(20)
      buf = buf.slice(24)

      let key = null, rawCode = null

      if (deviceType === 'wiimote' && type === EVDEV_KEYS.EV_KEY && value === 1) {
        // Boutons Wiimote uniquement (EV_KEY) — ignorés pour les manettes HAT (PS4, Xbox)
        switch (code) {
          case EVDEV_KEYS.KEY_UP:    key = 'ArrowUp';    rawCode = 'KEY_DPAD_UP';    break
          case EVDEV_KEYS.KEY_DOWN:  key = 'ArrowDown';  rawCode = 'KEY_DPAD_DOWN';  break
          case EVDEV_KEYS.KEY_LEFT:  key = 'ArrowLeft';  rawCode = 'KEY_DPAD_LEFT';  break
          case EVDEV_KEYS.KEY_RIGHT: key = 'ArrowRight'; rawCode = 'KEY_DPAD_RIGHT'; break
          case EVDEV_KEYS.BTN_SOUTH: key = 'Enter';      rawCode = 'BTN_SOUTH';      break
          case EVDEV_KEYS.BTN_1:     key = 'Enter';      rawCode = 'BTN_1';          break
          case EVDEV_KEYS.KEY_NEXT:  key = 'Enter';      rawCode = 'KEY_NEXT';       break
          case EVDEV_KEYS.BTN_EAST:  key = 'Escape';     rawCode = 'BTN_EAST';       break
          case EVDEV_KEYS.BTN_2:     key = 'Escape';     rawCode = 'BTN_2';          break
          case EVDEV_KEYS.KEY_PREV:  key = 'Escape';     rawCode = 'KEY_PREV';       break
          case EVDEV_KEYS.BTN_MODE:  key = 'Escape';     rawCode = 'BTN_MODE';       break
        }
      } else if (deviceType === 'hat' && type === EVDEV_KEYS.EV_ABS && value !== 0) {
        // D-pad HAT uniquement (PS4, Xbox) — EV_ABS ABS_HAT0X/Y
        if (code === EVDEV_KEYS.ABS_HAT0X) {
          if (value === -1) { key = 'ArrowLeft';  rawCode = 'HAT_LEFT';  }
          else              { key = 'ArrowRight'; rawCode = 'HAT_RIGHT'; }
        } else if (code === EVDEV_KEYS.ABS_HAT0Y) {
          if (value === -1) { key = 'ArrowUp';   rawCode = 'HAT_UP';   }
          else              { key = 'ArrowDown'; rawCode = 'HAT_DOWN'; }
        }
      }

      if (key && !evdevSuspended && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wiimote-dpad', { key, rawCode })
      }
    }
  })

  proc.on('close', () => {
    wiimoteReaders.delete(eventNode)
    console.log('[evdev] lecteur fermé pour', eventNode)
  })
  proc.on('error', err => {
    wiimoteReaders.delete(eventNode)
    console.error('[evdev] erreur pour', eventNode, ':', err.message)
  })
}

function stopAllEvdevReaders() {
  for (const [node, proc] of wiimoteReaders) {
    try { proc.kill() } catch(e) {}
    wiimoteReaders.delete(node)
  }
}

// Scan initial + surveillance udev des connexions/déconnexions
function startWiimoteWatcher() {
  // Scan immédiat
  findGamepadNodes(entries => {
    if (entries.length === 0) {
      console.log('[evdev] aucune manette avec HAT ou Wiimote trouvée pour l\'instant')
    }
    entries.forEach(e => spawnEvdevReader(e.node, e.type))
  })

  // Surveiller /dev/input via udevadm monitor pour détecter plug/unplug
  const udev = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=input'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })

  let udevBuf = ''
  udev.stdout.on('data', d => {
    udevBuf += d.toString()
    const lines = udevBuf.split('\n')
    udevBuf = lines.pop()
    for (const line of lines) {
      if (!line.includes('input')) continue
      if (line.includes('add')) {
        // Nouvelle connexion : attendre que /proc/bus/input/devices soit à jour
        setTimeout(() => {
          findGamepadNodes(entries => {
            entries.forEach(e => {
              if (!wiimoteReaders.has(e.node)) {
                console.log('[evdev] nouveau périphérique détecté:', e.node, '('+e.type+')')
                spawnEvdevReader(e.node, e.type)
              }
            })
          })
        }, 1000)
      } else if (line.includes('remove')) {
        // Déconnexion : les readers se fermeront d'eux-mêmes via 'close'
        console.log('[wiimote] déconnexion détectée')
      }
    }
  })

  udev.on('error', err => {
    console.warn('[wiimote] udevadm non disponible, polling toutes les 5s :', err.message)
    // Fallback : polling périodique si udevadm absent
    setInterval(() => {
      findNintendoNodes(nodes => {
        nodes.forEach(node => {
          if (!wiimoteReaders.has(node)) spawnEvdevReader(node)
        })
      })
    }, 5000)
  })
}

ipcMain.handle('wiimote-rescan', async () => {
  findGamepadNodes(entries => {
    console.log('[evdev] rescan manuel, périphériques trouvés:', entries.map(e => e.node))
    entries.forEach(e => {
      if (!wiimoteReaders.has(e.node)) spawnEvdevReader(e.node, e.type)
    })
  })
  return true
})