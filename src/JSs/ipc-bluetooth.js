/**
 * ipc-bluetooth.js
 * IPC : Bluetooth (liste, scan, pair, connect, disconnect, remove, rename, power).
 */

'use strict'

const { ipcMain } = require('electron')
const { exec, spawn } = require('child_process')
const { logDebug } = require('./helpers')

ipcMain.handle('bt-list-paired', async () => new Promise(resolve => {
  exec('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null', (err, out) => {
    if (err || !out.trim()) return resolve([])
    const devs = out.trim().split('\n').map(l => {
      const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/)
      return m ? { mac: m[1], name: m[2].trim() } : null
    }).filter(Boolean)
    Promise.all(devs.map(d => new Promise(r => {
      exec(`bluetoothctl info ${d.mac} 2>/dev/null`, (e, o) => {
        r({ ...d, connected: /Connected: yes/.test(o || ''), trusted: /Trusted: yes/.test(o || '') })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('bt-scan', async () => new Promise(resolve => {
  const discovered = new Map()
  const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
  proc.stdin.write('scan on\n')
  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const m = line.match(/Device ([0-9A-Fa-f:]{17})\s+(.+)/)
      if (m) {
        const [, mac, name] = m
        if (!discovered.has(mac) || name !== mac) discovered.set(mac, name.trim())
      }
    }
  })
  setTimeout(() => {
    try { proc.stdin.write('scan off\nquit\n'); proc.stdin.end() } catch (e) {}
    proc.kill()
    exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
      const pairedMacs = new Set(
        (paired || '').trim().split('\n')
          .map(l => { const m = l.match(/Device ([0-9A-Fa-f:]{17})/); return m ? m[1] : null })
          .filter(Boolean)
      )
      const results = []
      for (const [mac, name] of discovered) {
        results.push({ mac, name, paired: pairedMacs.has(mac), wiimote: /nintendo|rvl-cnt/i.test(name) })
      }
      resolve(results)
    })
  }, 12000)
}))

ipcMain.handle('bt-pair', async (_, mac) => new Promise(resolve => {
  exec(`bluetoothctl info ${mac} 2>/dev/null`, (err, info) => {
    const name      = (info || '').match(/Name: (.+)/)?.[1]?.trim() || ''
    const isWiimote = /nintendo|rvl-cnt/i.test(name)

    if (isWiimote) {
      logDebug(`bt-pair Wiimote : ${mac} — flow NoInputNoOutput`)
      exec('modprobe hid-wiimote 2>/dev/null', () => {
        exec('pkill -f "bt-agent" 2>/dev/null', () => {
          const agent = spawn('bt-agent', ['-c', 'NoInputNoOutput'], { stdio: 'ignore', detached: true })
          agent.unref()
          setTimeout(() => {
            const proc   = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
            let paired   = false
            proc.stdin.write('agent off\nagent NoInputNoOutput\ndefault-agent\nscan on\n')
            proc.stdout.on('data', chunk => {
              const text = chunk.toString()
              logDebug(`bt-pair stdout: ${text.trim()}`)
              if (!paired && text.includes(mac)) {
                paired = true
                logDebug(`bt-pair: Wiimote visible, lancement pair ${mac}`)
                proc.stdin.write(`pair ${mac}\n`)
              }
              if (/Pairing successful/i.test(text)) {
                logDebug('bt-pair: Pairing successful, trust en cours')
                proc.stdin.write(`trust ${mac}\nquit\n`)
              }
              if (/trust succeeded/i.test(text)) {
                try { proc.stdin.end() } catch (e) {}
              }
            })
            proc.on('close', () => {
              exec('pkill -f "bt-agent" 2>/dev/null', () => {})
              exec(`bluetoothctl info ${mac} 2>/dev/null`, (e, o) => {
                const ok = /Paired: yes/i.test(o || '')
                logDebug(`bt-pair résultat: paired=${ok}`)
                resolve(ok)
              })
            })
            setTimeout(() => {
              if (!paired) {
                logDebug('bt-pair timeout: Wiimote non détectée')
                try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) {}
                proc.kill()
              }
            }, 20000)
          }, 500)
        })
      })
    } else {
      const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
      let done   = false
      proc.stdout.on('data', chunk => {
        const text = chunk.toString()
        if (/Pairing successful|trust succeeded/i.test(text) && !done) {
          done = true
          try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) {}
        }
        if (/Pairing successful/i.test(text)) proc.stdin.write(`trust ${mac}\n`)
      })
      proc.on('close', () => {
        exec(`bluetoothctl info ${mac} 2>/dev/null`, (e, o) =>
          resolve(/Paired: yes/i.test(o || '') || /Connected: yes/i.test(o || '')))
      })
      proc.stdin.write(`pair ${mac}\n`)
      setTimeout(() => {
        if (!done) { try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) {} proc.kill() }
      }, 15000)
    }
  })
}))

ipcMain.handle('bt-connect',    async (_, mac) => new Promise(r => exec(`bluetoothctl connect ${mac}`,    (e, o) => r(!e && /Connection successful/i.test(o || '')))))
ipcMain.handle('bt-disconnect', async (_, mac) => new Promise(r => exec(`bluetoothctl disconnect ${mac}`, e => r(!e))))
ipcMain.handle('bt-remove',     async (_, mac) => new Promise(r => exec(`bluetoothctl remove ${mac}`,     e => r(!e))))

ipcMain.handle('bt-rename', async (_, mac, name) => {
  const { loadConfig, saveConfig } = require('./helpers')
  const cfg = loadConfig()
  if (!cfg.btNames) cfg.btNames = {}
  cfg.btNames[mac] = name
  saveConfig(cfg)
  return true
})

ipcMain.handle('bt-status', async () => new Promise(resolve => {
  exec('bluetoothctl show 2>/dev/null', (err, out) =>
    resolve({ powered: /Powered: yes/i.test(out || ''), discoverable: /Discoverable: yes/i.test(out || '') }))
}))

ipcMain.handle('bt-power', async (_, on) => new Promise(r => exec(`bluetoothctl power ${on ? 'on' : 'off'}`, e => r(!e))))
