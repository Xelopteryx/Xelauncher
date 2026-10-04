/**
 * ipc-bluetooth.js
 * IPC : Bluetooth (liste, scan en flux, appairage par type, connexion, etc.).
 *
 * Changements majeurs par rapport à l'ancienne version :
 *  - Le scan n'attend plus 12 s pour tout renvoyer d'un bloc : il tourne en
 *    arrière-plan et pousse chaque appareil au renderer dès qu'il est
 *    identifié (événements 'bt-scan-device' / 'bt-scan-done').
 *  - Chaque appareil est classé (audio / controller / wiimote / keyboard /
 *    other) à partir de `bluetoothctl info` (Icon, Class, UUIDs) + nom.
 *  - L'appairage dépend du type et se fait dans UNE seule session
 *    bluetoothctl : pair -> trust -> connect, avec agent (confirmation
 *    automatique, code affiché pour les claviers).
 *  - Plus aucune écriture sur un stdin déjà fermé : c'était la cause de
 *    l'erreur JavaScript (write after end) quand on appairait un casque.
 */

'use strict'

const { ipcMain } = require('electron')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const { logDebug, loadConfig, saveConfig } = require('./helpers')
const { getMainWindow } = require('./main-window')

const ANSI_RE     = /\x1b\[[0-9;?]*[A-Za-z]|[\x01\x02\r]/g
const MAC_RE      = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i
const SCAN_MAX_MS = 15 * 60 * 1000   // la recherche dure tant que le menu est ouvert (le renderer la relance si besoin)
const PAIR_MAX_MS = 45000

/* ── Utilitaires ── */
const validMac = m => typeof m === 'string' && MAC_RE.test(m)

function send(channel, payload) {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function run(cmd, timeout = 5000) {
  return new Promise(res => exec(cmd, { timeout }, (e, out) => res(out || '')))
}

function parseInfo(out) {
  const get = re => { const m = out.match(re); return m ? m[1].trim() : '' }
  const rssi = out.match(/RSSI:\s*0x[0-9a-f]+\s*\((-?\d+)\)/i)
  return {
    name:      get(/^\s*Name:\s*(.+)$/m) || get(/^\s*Alias:\s*(.+)$/m),
    icon:      get(/^\s*Icon:\s*(.+)$/m),
    cls:       parseInt(get(/^\s*Class:\s*(0x[0-9a-f]+)/im), 16) || 0,
    uuids:     [...out.matchAll(/UUID:.*?\(([0-9a-f-]{36})\)/gi)].map(m => m[1].toLowerCase()),
    paired:    /Paired:\s*yes/i.test(out),
    connected: /Connected:\s*yes/i.test(out),
    trusted:   /Trusted:\s*yes/i.test(out),
    rssi:      rssi ? parseInt(rssi[1], 10) : null,
  }
}

/* ── Classification ──
   Ordre : Wiimote (par nom) > Icon BlueZ > Class of Device > UUIDs > nom. */
const AUDIO_UUID_PREFIXES = ['0000110a', '0000110b', '0000110d', '00001108', '0000111e', '0000111f']

function classify(name, info) {
  if (/nintendo|rvl-cnt|wiimote|wii remote/i.test(name)) return 'wiimote'

  const icon = info.icon || ''
  if (/^audio-/.test(icon))        return 'audio'
  if (icon === 'input-gaming')     return 'controller'
  if (/^input-(keyboard|mouse|tablet)$/.test(icon)) return 'keyboard'

  const major = (info.cls >> 8) & 0x1f
  if (major === 4) return 'audio'
  if (major === 5) {
    /* bits 6-7 : clavier / pointeur ; sinon joystick, gamepad, télécommande… */
    return ((info.cls >> 6) & 3) ? 'keyboard' : 'controller'
  }

  if (info.uuids.some(u => AUDIO_UUID_PREFIXES.some(p => u.startsWith(p)))) return 'audio'
  if (info.uuids.some(u => u.startsWith('00001124'))) return 'controller'   // HID générique

  if (/headphone|headset|casque|earbud|earphone|buds|airpods|speaker|enceinte|soundbar|soundcore|jbl|bose|\bwh-|\bwf-/i.test(name)) return 'audio'
  if (/controller|gamepad|joy-?con|dualshock|dualsense|xbox|8bitdo/i.test(name)) return 'controller'
  if (/keyboard|clavier|mouse|souris|trackpad/i.test(name)) return 'keyboard'
  return 'other'
}

/* ═══════════════════════════════════════════════════════════════
   APPAREILS APPAIRÉS
═══════════════════════════════════════════════════════════════ */
ipcMain.handle('bt-list-paired', async () => {
  const out = await run('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null')
  const names = (loadConfig().btNames) || {}
  const devs = out.trim().split('\n').map(l => {
    const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/)
    return m ? { mac: m[1].toUpperCase(), name: m[2].trim() } : null
  }).filter(Boolean)

  const full = await Promise.all(devs.map(async d => {
    const info = parseInfo(await run(`bluetoothctl info ${d.mac} 2>/dev/null`))
    return {
      mac: d.mac,
      name: names[d.mac] || info.name || d.name,
      origName: info.name || d.name,
      paired: info.paired,
      connected: info.connected,
      trusted: info.trusted,
      type: classify(info.name || d.name, info),
    }
  }))
  return full.filter(d => d.paired)
})

/* ═══════════════════════════════════════════════════════════════
   SCAN EN FLUX
═══════════════════════════════════════════════════════════════ */
let scan = null   // { proc, timer, timers:Map, counts:Map, emitted:Map }

function finishScan(st, error) {
  if (scan !== st) return
  scan = null
  clearTimeout(st.timer)
  st.timers.forEach(clearTimeout)
  send('bt-scan-done', error ? { error: String(error) } : {})
}

function stopScan(notify) {
  const st = scan
  if (!st) return
  scan = null
  clearTimeout(st.timer)
  st.timers.forEach(clearTimeout)
  try { if (st.proc.stdin.writable) { st.proc.stdin.write('scan off\nquit\n'); st.proc.stdin.end() } } catch (e) {}
  setTimeout(() => { try { st.proc.kill() } catch (e) {} }, 800)
  if (notify) send('bt-scan-done', {})
}

/* Résout (info + classification) un appareil vu pendant le scan, puis
   l'envoie au renderer. Débouncé par MAC, et plafonné à 4 résolutions par
   appareil pour ne pas boucler sur les balises BLE bavardes. */
function scheduleResolve(st, mac, delay) {
  if (st.timers.has(mac)) return
  const n = st.counts.get(mac) || 0
  if (n >= 4) return
  st.counts.set(mac, n + 1)
  st.timers.set(mac, setTimeout(async () => {
    st.timers.delete(mac)
    if (scan !== st) return
    const info = parseInfo(await run(`bluetoothctl info ${mac} 2>/dev/null`, 4000))
    if (scan !== st) return

    const name = info.name
    /* Pas encore de vrai nom (BlueZ met l'adresse avec des tirets) : on
       attend un prochain [CHG] Name, ça évite d'afficher des dizaines
       d'appareils anonymes. */
    if (!name || name.replace(/-/g, ':').toUpperCase() === mac) return

    const type = classify(name, info)
    const prev = st.emitted.get(mac)
    if (prev && prev.name === name && prev.type === type && prev.paired === info.paired) return
    st.emitted.set(mac, { name, type, paired: info.paired })
    send('bt-scan-device', {
      mac, name, type,
      paired: info.paired, connected: info.connected, rssi: info.rssi,
    })
  }, delay))
}

function scanLine(st, line) {
  const m = line.match(/\[(NEW|CHG)\]\s+Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i)
  if (!m) return
  const kind = m[1].toUpperCase()
  const mac  = m[2].toUpperCase()
  /* Les [CHG] RSSI / ManufacturerData / TxPower arrivent en continu : on ne
     relance une résolution que pour les changements qui peuvent modifier
     le nom ou le type. */
  if (kind === 'CHG' && !/^(Name|Alias|Class|Icon|UUIDs?|Paired|Appearance|Modalias)\b/i.test(m[3])) return
  scheduleResolve(st, mac, 600)
}

function startScan() {
  stopScan(false)
  let proc
  try {
    proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
  } catch (e) {
    send('bt-scan-done', { error: e.message })
    return
  }
  const st = { proc, timer: null, timers: new Map(), counts: new Map(), emitted: new Map() }
  scan = st

  proc.stdin.on('error', () => {})
  proc.on('error', e => { logDebug('bt-scan: ' + e.message); finishScan(st, e.message) })
  proc.on('close', () => finishScan(st))

  let buf = ''
  proc.stdout.on('data', chunk => {
    buf += chunk.toString().replace(ANSI_RE, '')
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) scanLine(st, line)
  })

  try { proc.stdin.write('power on\nscan on\n') } catch (e) {}

  /* Appareils déjà en cache BlueZ : visibles tout de suite, sans attendre
     qu'ils ré-émettent une annonce. */
  run('bluetoothctl devices 2>/dev/null').then(out => {
    for (const l of out.split('\n')) {
      const m = l.match(/Device ([0-9A-Fa-f:]{17})/)
      if (m && scan === st) scheduleResolve(st, m[1].toUpperCase(), 0)
    }
  })

  st.timer = setTimeout(() => stopScan(true), SCAN_MAX_MS)
}

ipcMain.handle('bt-scan-start', async () => { startScan(); return true })
ipcMain.handle('bt-scan-stop',  async () => { stopScan(false); return true })

/* ═══════════════════════════════════════════════════════════════
   APPAIRAGE
═══════════════════════════════════════════════════════════════ */
function btErrorFor(line, type) {
  if (/profile-unavailable/i.test(line)) {
    return type === 'audio'
      ? 'profil audio indisponible (paquets pipewire + libspa-0.2-bluetooth, ou pulseaudio-module-bluetooth)'
      : 'profil Bluetooth indisponible'
  }
  return 'connexion échouée'
}

/* Casques, enceintes, manettes, claviers, souris… :
   pair -> trust -> connect dans une seule session bluetoothctl. */
function pairGeneric(mac, type, progress) {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      return resolve({ ok: false, paired: false, connected: false, error: e.message })
    }
    proc.stdin.on('error', () => {})

    let done = false, buf = '', connectSent = false, connectTries = 0, lastError = ''
    const write = s => { if (proc.stdin.writable) { try { proc.stdin.write(s) } catch (e) {} } }

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      write('quit\n')
      try { proc.stdin.end() } catch (e) {}
      setTimeout(() => { try { proc.kill() } catch (e) {} }, 500)
      const readInfo = () => run(`bluetoothctl info ${mac} 2>/dev/null`)
      readInfo().then(async o => {
        let info = parseInfo(o)
        /* Un casque peut afficher "Connection successful" puis se déconnecter
           aussitôt si aucun profil audio n'est disponible côté système :
           on revérifie après quelques secondes. */
        if (info.connected && (type === 'audio' || type === 'controller')) {
          await new Promise(r => setTimeout(r, 2500))
          info = parseInfo(await readInfo())
          if (!info.connected) lastError = lastError || (type === 'audio' ? "le casque s'est déconnecté aussitôt (profil audio indisponible)" : "l'appareil s'est déconnecté aussitôt")
        }
        logDebug(`bt-pair ${mac} (${type}) : paired=${info.paired} connected=${info.connected} err="${lastError}"`)
        resolve({
          ok: info.paired,
          paired: info.paired,
          connected: info.connected,
          error: info.paired ? (info.connected ? '' : lastError) : (lastError || 'appairage échoué'),
        })
      })
    }
    const timer = setTimeout(() => { lastError = lastError || 'délai dépassé'; finish() }, PAIR_MAX_MS)

    const afterPaired = () => {
      if (connectSent) return
      connectSent = true
      progress('connect')
      write(`trust ${mac}\n`)
      setTimeout(() => write(`connect ${mac}\n`), 400)
    }

    const handleLine = line => {
      if (!line.trim()) return
      logDebug('bt-pair: ' + line.trim())
      const code = line.match(/(?:Passkey|PIN code):\s*(\d+)/i)
      if (code) progress('passkey', { code: code[1] })

      if (/AlreadyExists|Already Exists/i.test(line))  return afterPaired()
      if (/Pairing successful/i.test(line))            return afterPaired()
      if (/Device \S+ not available/i.test(line)) {
        lastError = 'appareil introuvable — relancez la recherche'
        return finish()
      }
      if (/Failed to pair/i.test(line)) {
        lastError = /Authentication/i.test(line) ? 'authentification refusée' : 'appairage refusé'
        return finish()
      }
      if (/Connection successful/i.test(line))         return finish()
      if (/Failed to connect/i.test(line)) {
        if (connectSent && connectTries < 2 && !/profile-unavailable/i.test(line)) {
          connectTries++
          setTimeout(() => write(`connect ${mac}\n`), 1500)
          return
        }
        lastError = btErrorFor(line, type)
        return finish()
      }
    }

    proc.stdout.on('data', chunk => {
      buf += chunk.toString().replace(ANSI_RE, '')
      const lines = buf.split('\n')
      buf = lines.pop()
      lines.forEach(handleLine)
      /* Invites sans retour à la ligne : on y répond tout de suite. */
      if (/\(yes\/no\)\s*:?\s*$/i.test(buf))  { write('yes\n'); buf = '' }
      else if (/Enter PIN code:\s*$/i.test(buf)) { write('0000\n'); buf = '' }
    })
    proc.on('close', finish)

    write('power on\nagent KeyboardDisplay\ndefault-agent\n')
    /* Laisser à l'agent le temps de s'enregistrer côté D-Bus avant pair. */
    setTimeout(() => write(`pair ${mac}\n`), 700)
  })
}

/* Wiimote : agent NoInputNoOutput (bt-agent), appairage pendant que la
   Wiimote est visible (1+2 ou SYNC). Flux repris de l'ancienne version. */
function pairWiimote(mac, progress) {
  return new Promise(resolve => {
    logDebug(`bt-pair Wiimote : ${mac} — flow NoInputNoOutput`)
    exec('modprobe hid-wiimote 2>/dev/null', () => {
      exec('pkill -f "bt-agent" 2>/dev/null', () => {
        const agent = spawn('bt-agent', ['-c', 'NoInputNoOutput'], { stdio: 'ignore', detached: true })
        agent.on('error', () => {})
        agent.unref()

        setTimeout(() => {
          const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
          proc.stdin.on('error', () => {})
          const write = s => { if (proc.stdin.writable) { try { proc.stdin.write(s) } catch (e) {} } }
          const quit  = () => {
            write('quit\n')
            try { proc.stdin.end() } catch (e) {}
            setTimeout(() => { try { proc.kill() } catch (e) {} }, 500)
          }
          const mu = mac.toUpperCase()
          let started = false

          const timer = setTimeout(() => { logDebug('bt-pair timeout Wiimote'); quit() }, 25000)

          proc.stdout.on('data', chunk => {
            const text = chunk.toString().replace(ANSI_RE, '')
            logDebug('bt-pair stdout: ' + text.trim())
            if (!started && text.toUpperCase().includes(mu)) {
              started = true
              progress('connect')
              write(`pair ${mac}\n`)
            }
            if (/Pairing successful|AlreadyExists/i.test(text)) write(`trust ${mac}\n`)
            if (/trust succeeded|Changing .* trust succeeded/i.test(text)) quit()
          })

          proc.on('close', () => {
            clearTimeout(timer)
            exec('pkill -f "bt-agent" 2>/dev/null', () => {})
            run(`bluetoothctl info ${mac} 2>/dev/null`).then(o => {
              const info = parseInfo(o)
              logDebug(`bt-pair Wiimote résultat: paired=${info.paired}`)
              resolve({
                ok: info.paired, paired: info.paired, connected: info.connected,
                error: info.paired ? '' : 'Wiimote non détectée — maintenez 1+2 (ou SYNC) pendant la recherche',
              })
            })
          })

          write('agent off\nagent NoInputNoOutput\ndefault-agent\nscan on\n')
        }, 500)
      })
    })
  })
}

ipcMain.handle('bt-pair', async (_, mac, type) => {
  if (!validMac(mac)) return { ok: false, paired: false, connected: false, error: 'adresse invalide' }
  mac = mac.toUpperCase()
  stopScan(false)   // une recherche active ralentit/perturbe l'appairage et la connexion
  const progress = (stage, extra) => send('bt-pair-progress', { stage, ...(extra || {}) })
  return type === 'wiimote' ? pairWiimote(mac, progress) : pairGeneric(mac, type || 'other', progress)
})

/* ═══════════════════════════════════════════════════════════════
   CONNEXION / GESTION
═══════════════════════════════════════════════════════════════ */
ipcMain.handle('bt-connect', async (_, mac) => {
  if (!validMac(mac)) return false
  stopScan(false)
  const out = await run(`bluetoothctl connect ${mac}`, 25000)
  if (!/Connection successful/i.test(out)) {
    logDebug(`bt-connect ${mac} : ${out.trim().split('\n').slice(-2).join(' | ')}`)
    return false
  }
  /* Même vérification que pour l'appairage : la connexion doit tenir. */
  await new Promise(r => setTimeout(r, 2000))
  const info = parseInfo(await run(`bluetoothctl info ${mac} 2>/dev/null`))
  if (!info.connected) { logDebug(`bt-connect ${mac} : déconnecté aussitôt (profil audio indisponible ?)`); return false }
  return true
})

/* Noms personnalisés (MAC -> nom), pour que Audio / Manettes / Jellyfin
   affichent le même nom que celui donné dans Bluetooth. */
ipcMain.handle('bt-names', async () => (loadConfig().btNames) || {})

/* Une manette Bluetooth n'est réellement utilisable que lorsque le noyau
   crée son périphérique d'entrée (BlueZ y inscrit l'adresse dans « Uniq »).
   On attend donc son apparition au lieu de se fier à « Connected: yes ». */
ipcMain.handle('bt-input-ready', async (_, mac, timeoutMs) => {
  if (!validMac(mac)) return false
  const needle = new RegExp('Uniq=' + mac.toLowerCase(), 'i')
  const limit  = Math.min(Math.max(parseInt(timeoutMs) || 0, 0), 30000)
  const t0 = Date.now()
  do {
    try { if (needle.test(fs.readFileSync('/proc/bus/input/devices', 'utf8'))) return true } catch (e) {}
    await new Promise(r => setTimeout(r, 500))
  } while (Date.now() - t0 < limit)
  return false
})

/* Diagnostic : cherche pourquoi un appareil se connecte mal (type: audio | controller | wiimote). */
ipcMain.handle('bt-diagnose', async (_, mac, type) => {
  if (!validMac(mac)) return { problems: ['adresse invalide'] }
  const key = mac.replace(/:/g, '_').toLowerCase()
  const isInput = type === 'controller' || type === 'wiimote'
  const [svc, spa, pamod, wp, pactlInfo, cards, journal, infoOut, bluetoothd] = await Promise.all([
    run('systemctl is-active bluetooth 2>/dev/null'),
    run("dpkg-query -W -f='${Status}' libspa-0.2-bluetooth 2>/dev/null"),
    run("dpkg-query -W -f='${Status}' pulseaudio-module-bluetooth 2>/dev/null"),
    run('pgrep -x wireplumber 2>/dev/null'),
    run('pactl info 2>/dev/null'),
    run('pactl list cards short 2>/dev/null'),
    run('journalctl -u bluetooth -n 60 --no-pager 2>/dev/null | grep -iE "a2dp|profile|input|hid|refused|reject|fail" | tail -6'),
    run(`bluetoothctl info ${mac} 2>/dev/null`),
    run('pgrep -a bluetoothd 2>/dev/null'),
  ])
  const installed = x => /install ok installed/.test(x)
  const pipewire  = /PipeWire/i.test(pactlInfo)
  const info      = parseInfo(infoOut)
  const problems  = []

  if (!/^active/.test(svc.trim())) problems.push('service bluetooth arrêté (sudo systemctl enable --now bluetooth)')

  if (isInput) {
    if (/noplugin[^\n]*input/i.test(bluetoothd)) problems.push('bluetoothd est lancé avec le plugin « input » désactivé')
    if (!fs.existsSync('/dev/uhid'))             problems.push('module noyau uhid absent (sudo modprobe uhid)')
    if (info.paired && info.uuids.length && !info.uuids.some(u => u.startsWith('00001124')))
      problems.push('l’appareil n’annonce pas de profil manette (HID) — est-il bien en mode appairage ?')
  } else {
    if (!pactlInfo.trim())                       problems.push('serveur audio injoignable (pipewire-pulse / pulseaudio non lancé)')
    else if (pipewire && !installed(spa))        problems.push('paquet libspa-0.2-bluetooth manquant (sudo apt install libspa-0.2-bluetooth), puis redémarrez')
    else if (!pipewire && !installed(pamod))     problems.push('paquet pulseaudio-module-bluetooth manquant')
    if (pipewire && !wp.trim())                  problems.push('wireplumber non lancé (il gère le Bluetooth sous PipeWire)')
  }

  if (!info.paired)       problems.push('appareil non appairé — remettez-le en mode appairage')
  else if (!info.trusted) problems.push('appareil appairé mais non approuvé')
  if (!isInput && !problems.length && info.connected && !cards.toLowerCase().includes(key))
    problems.push('connecté, mais le serveur audio n’a créé aucune carte Bluetooth')

  logDebug(`bt-diagnose ${mac} (${type || 'audio'}) : service=${svc.trim()} serveur=${pipewire ? 'PipeWire' : (pactlInfo.trim() ? 'PulseAudio' : 'aucun')} ` +
           `libspa=${installed(spa)} wireplumber=${!!wp.trim()} uhid=${fs.existsSync('/dev/uhid')} paired=${info.paired} trusted=${info.trusted} ` +
           `connected=${info.connected} uuids=${info.uuids.join(',')} problèmes=[${problems.join(' ; ')}] bluez: ${journal.trim().replace(/\n/g, ' | ')}`)
  return { problems }
})

ipcMain.handle('bt-disconnect', async (_, mac) => {
  if (!validMac(mac)) return false
  return new Promise(r => exec(`bluetoothctl disconnect ${mac}`, { timeout: 10000 }, e => r(!e)))
})

ipcMain.handle('bt-remove', async (_, mac) => {
  if (!validMac(mac)) return false
  return new Promise(r => exec(`bluetoothctl remove ${mac}`, { timeout: 10000 }, e => r(!e)))
})

ipcMain.handle('bt-rename', async (_, mac, name) => {
  if (!validMac(mac)) return false
  const cfg = loadConfig()
  if (!cfg.btNames) cfg.btNames = {}
  cfg.btNames[mac.toUpperCase()] = name
  saveConfig(cfg)
  return true
})

/* Casque connecté mais sans sortie audio : certains casques se connectent
   en profil « téléphone » (HFP) ou sans profil. On bascule leur carte audio
   en A2DP (nom du profil : a2dp-sink sous PipeWire, a2dp_sink sous PulseAudio). */
ipcMain.handle('bt-audio-fix', async (_, mac) => {
  if (!validMac(mac)) return { ok: false, error: 'adresse invalide' }
  const key   = mac.replace(/:/g, '_').toLowerCase()
  const cards = await run('pactl list cards short 2>/dev/null')
  const line  = cards.split('\n').find(l => l.toLowerCase().includes(key))
  if (!line) return { ok: false, error: 'aucune carte audio Bluetooth (paquets pipewire-audio / libspa-0.2-bluetooth ?)' }
  const card = (line.split('\t')[1] || '').trim()
  if (!/^[\w.:\-]+$/.test(card)) return { ok: false, error: 'nom de carte invalide' }
  for (const prof of ['a2dp-sink', 'a2dp_sink']) {
    await run(`pactl set-card-profile ${card} ${prof} 2>/dev/null`)
    const sinks = await run('pactl list short sinks 2>/dev/null')
    if (sinks.toLowerCase().includes(key)) { logDebug(`bt-audio-fix ${mac} : profil ${prof}`); return { ok: true } }
  }
  return { ok: false, error: 'profil A2DP indisponible' }
})

ipcMain.handle('bt-status', async () => {
  const out = await run('bluetoothctl show 2>/dev/null')
  return { powered: /Powered: yes/i.test(out), discoverable: /Discoverable: yes/i.test(out) }
})

ipcMain.handle('bt-power', async (_, on) => {
  if (!on) stopScan(false)
  return new Promise(r => exec(
    `${on ? 'rfkill unblock bluetooth 2>/dev/null; ' : ''}bluetoothctl power ${on ? 'on' : 'off'}`,
    { timeout: 10000 }, e => r(!e)))
})
