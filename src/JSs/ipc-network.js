/**
 * ipc-network.js
 * IPC : interfaces réseau, WiFi (scan, connect, forget, known, priority, static IP).
 */

'use strict'

const { ipcMain } = require('electron')
const { exec }    = require('child_process')

/* ── Interfaces ── */
ipcMain.handle('get-interfaces', async () => new Promise(resolve => {
  exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const ifaces = out.trim().split('\n').filter(Boolean)
    Promise.all(ifaces.map(iface => new Promise(res => {
      iface = iface.trim()
      exec(`ip link show ${iface}`, (e1, lo) => {
        const up = /LOWER_UP/.test(lo || '') || (/[<,]UP[,>]/.test(lo || '') && !/NO-CARRIER/.test(lo || ''))
        exec(`ip -4 addr show ${iface}`, (e2, ao) => {
          const m    = ao && ao.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
          const ip   = m ? m[1] : null
          const cidr = m ? m[2] : null
          if (!ip) {
            res({ name: iface, ip: null, cidr: null, gateway: null, dns: null, state: up ? 'up' : 'down' })
            return
          }
          exec(`ip route show table all dev ${iface} 2>/dev/null | grep "^default via"`, (e3, rto) => {
            const gwm     = (rto || '').match(/default via (\d+\.\d+\.\d+\.\d+)/)
            let gateway   = gwm ? gwm[1] : null
            const finalize = (gw) => {
              exec(`nmcli dev show ${iface} 2>/dev/null`, (e4, nmo) => {
                const dnsMatches = nmo
                  ? [...nmo.matchAll(/IP4\.DNS\[\d+\]:\s+(\S+)/g)].map(x => x[1]).filter(x => x !== '--')
                  : []
                res({ name: iface, ip, cidr, gateway: gw, dns: dnsMatches.length ? dnsMatches : null, state: up ? 'up' : 'down' })
              })
            }
            if (gateway) return finalize(gateway)
            exec(`sudo grep -r "via\\|gateway4" /etc/netplan/ 2>/dev/null`, (e5, npo) => {
              const vim  = (npo || '').match(/via:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
              const gw4m = (npo || '').match(/gateway4:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
              finalize((vim || gw4m) ? (vim ? vim[1] : gw4m[1]) : null)
            })
          })
        })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('get-ip-addresses', async () => {
  const getIP = iface => new Promise(r => {
    exec(`ip -4 addr show ${iface}`, (err, out) => {
      const m = out && out.match(/inet (\d+\.\d+\.\d+\.\d+)/)
      r(m ? m[1] : null)
    })
  })
  const [wifi, eth] = await Promise.all([getIP('wlan0'), getIP('eth0')])
  return { wifi, eth }
})

/* ── WiFi ── */
ipcMain.handle('wifi-scan', async () => new Promise(resolve => {
  exec('nmcli --fields SSID,SIGNAL,SECURITY --terse dev wifi list 2>/dev/null', (err, out) => {
    if (err || !out) return resolve([])
    const seen = new Set()
    const nets = out.trim().split('\n').map(line => {
      const p = line.split(':')
      if (p.length < 3) return null
      return { ssid: p[0].trim(), signal: p[1].trim() || '0', security: p[2].trim() || '' }
    }).filter(n => {
      if (!n || !n.ssid || n.ssid === '--') return false
      if (seen.has(n.ssid)) return false
      seen.add(n.ssid); return true
    })
    resolve(nets)
  })
}))

ipcMain.handle('wifi-connect', async (_, ssid, pwd) => new Promise(resolve => {
  const s   = ssid.replace(/'/g, "'\\''")
  const cmd = pwd
    ? `nmcli dev wifi connect '${s}' password '${pwd.replace(/'/g, "'\\''")}' `
    : `nmcli dev wifi connect '${s}'`
  exec(cmd, err => resolve(!err))
}))

ipcMain.handle('wifi-forget', async (_, ssid) => new Promise(resolve => {
  exec(`nmcli connection delete '${ssid.replace(/'/g, "'\\''")}' `, err => resolve(!err))
}))

ipcMain.handle('wifi-current-ssid', async () => new Promise(resolve => {
  exec('nmcli -t -f ACTIVE,SSID dev wifi 2>/dev/null', (err, out) => {
    if (!err && out) {
      const line = out.trim().split('\n').find(l => l.startsWith('yes:'))
      if (line) return resolve(line.slice(4))
    }
    exec('iwgetid -r 2>/dev/null', (e2, o2) => { resolve((o2 || '').trim()) })
  })
}))

ipcMain.handle('wifi-get-known', async () => new Promise(resolve => {
  exec("nmcli -t -f NAME,TYPE connection show 2>/dev/null", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const names = out.trim().split('\n')
      .map(l => { const p = l.split(':'); return p[1] === '802-11-wireless' ? p[0] : null })
      .filter(Boolean)
    if (!names.length) return resolve([])
    Promise.all(names.map(name => new Promise(res => {
      exec(`nmcli -t -f 802-11-wireless.ssid,802-11-wireless-security.key-mgmt connection show '${name.replace(/'/g, "'\\''")}' 2>/dev/null`, (e, o) => {
        if (e || !o) return res(null)
        const ssidMatch = o.match(/802-11-wireless\.ssid:(.+)/)
        const secMatch  = o.match(/802-11-wireless-security\.key-mgmt:(.+)/)
        const ssid      = ssidMatch ? ssidMatch[1].trim() : name
        const sec       = secMatch  ? secMatch[1].trim()  : ''
        res({ ssid, security: (!sec || sec === '--') ? 'Open' : sec })
      })
    }))).then(nets => resolve(nets.filter(Boolean)))
  })
}))

ipcMain.handle('wifi-set-priority', async (_, ssids) => new Promise(resolve => {
  if (!ssids || !ssids.length) return resolve(true)
  const total = ssids.length
  exec("nmcli -t -f NAME,TYPE connection show 2>/dev/null", (err, out) => {
    if (err || !out.trim()) return resolve(false)
    const wifiConns = out.trim().split('\n')
      .map(l => { const p = l.split(':'); return p[1] === '802-11-wireless' ? p[0] : null })
      .filter(Boolean)
    Promise.all(ssids.map((ssid, i) => new Promise(res => {
      const priority   = total - i
      const candidates = wifiConns.filter(n => n === ssid || n.toLowerCase().includes(ssid.toLowerCase()))
      const connName   = candidates[0]
      if (!connName) return res(false)
      exec(`nmcli connection modify '${connName.replace(/'/g, "'\\''")}' connection.autoconnect-priority ${priority}`, e => res(!e))
    }))).then(results => resolve(results.every(Boolean)))
  })
}))

ipcMain.handle('wifi-disconnect', async () => new Promise(resolve => {
  exec("nmcli -t -f DEVICE,TYPE device 2>/dev/null", (err, out) => {
    const wlanDev = (!err && out)
      ? (out.trim().split('\n').map(l => l.split(':')).find(p => p[1] === 'wifi') || [])[0]
      : 'wlan0'
    exec(`nmcli device disconnect '${(wlanDev || 'wlan0').replace(/'/g, "'\\''")}' 2>/dev/null`, e => resolve(!e))
  })
}))

ipcMain.handle('set-static-ip', async (_, opts) => {
  const { iface, dhcp, ip, mask, gw, dns } = opts
  if (!iface) return false
  const cidr   = (mask || '255.255.255.0').split('.').reduce((a, o) => a + (parseInt(o) >>> 0).toString(2).split('1').length - 1, 0)
  const dnsVal = dns || '1.1.1.1 1.0.0.1'
  const useNM  = await new Promise(r => exec('systemctl is-active NetworkManager', (e, o) => r(!e && o.trim() === 'active')))
  if (!useNM) return false
  return new Promise(resolve => {
    exec('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null', (e, out) => {
      let conn = null
      if (out) {
        const line = out.trim().split('\n').find(l => l.endsWith(':' + iface))
        if (line) conn = line.split(':')[0]
      }
      if (!conn) {
        conn = 'xelauncher-' + iface
        exec(`nmcli connection delete '${conn}' 2>/dev/null`, () => {})
      }
      const cmd = dhcp
        ? `nmcli connection modify '${conn}' ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""`
        : `nmcli connection modify '${conn}' ipv4.method manual ipv4.addresses '${ip}/${cidr}' ipv4.gateway '${gw || ''}' ipv4.dns '${dnsVal}'`
      exec(cmd, err => {
        if (err) return resolve(false)
        exec(`nmcli connection up '${conn}' ifname ${iface}`, err2 => resolve(!err2))
      })
    })
  })
})
