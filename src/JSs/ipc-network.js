/**
 * ipc-network.js
 * IPC : interfaces réseau, WiFi (scan, connect, forget, known, priority, static IP).
 */

'use strict'

const { ipcMain } = require('electron')
const { exec }    = require('child_process')

/* -- Interfaces -- */
ipcMain.handle('get-interfaces', async () => new Promise(resolve => {
  exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const ifaces = out.trim().split('\n').filter(Boolean)
    Promise.all(ifaces.map(iface => new Promise(res => {
      iface = iface.trim()
      exec(`ip link show ${iface}`, (e1, lo) => {
        const up = /LOWER_UP/.test(lo || '') || (/[<,]UP[,>]/.test(lo || '') && !/NO-CARRIER/.test(lo || ''))
        const mac = ((lo || '').match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1] || null
        exec(`ip -4 addr show ${iface}`, (e2, ao) => {
          const m    = ao && ao.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
          const ip   = m ? m[1] : null
          const cidr = m ? m[2] : null
          if (!ip) {
            res({ name: iface, mac, ip: null, cidr: null, gateway: null, dns: null, state: up ? 'up' : 'down' })
            return
          }
          exec(`nmcli dev show ${iface} 2>/dev/null`, (e3, nmo) => {
            /* nmcli expose DIRECTEMENT la passerelle d'une interface via
               IP4.GATEWAY — bien plus fiable que reconstruire depuis
               "ip route" (table/format qui varie selon les configs, et
               qui ne remontait rien ici). On garde "ip route" + netplan
               en repli uniquement pour les interfaces que NetworkManager
               ne gère pas du tout (ex. tailscale0, où nmcli ne reporte
               souvent rien d'utile). */
            const gwMatch  = nmo && nmo.match(/IP4\.GATEWAY:\s+(\S+)/)
            const gateway  = (gwMatch && gwMatch[1] !== '--') ? gwMatch[1] : null
            const dnsMatches = nmo
              ? [...nmo.matchAll(/IP4\.DNS\[\d+\]:\s+(\S+)/g)].map(x => x[1]).filter(x => x !== '--')
              : []
            /* Méthode d'adressage (DHCP "auto" vs Statique "manual") —
               absente jusqu'ici, ce qui faisait toujours partir le
               panneau en mode Statique par défaut, même pour une
               interface en DHCP. */
            const connMatch = nmo && nmo.match(/GENERAL\.CONNECTION:\s+(.+)/)
            const connName  = connMatch ? connMatch[1].trim() : null

            const finalize = (gw, method) => {
              res({
                name: iface, mac, ip, cidr, gateway: gw,
                dns: dnsMatches.length ? dnsMatches : null,
                state: up ? 'up' : 'down',
                dhcp: method !== 'manual',
              })
            }
            const withMethod = (gw) => {
              if (!connName || connName === '--') return finalize(gw, null)
              exec(`nmcli -g ipv4.method connection show "${connName.replace(/"/g, '\\"')}" 2>/dev/null`, (e6, mo) => {
                finalize(gw, (mo || '').trim())
              })
            }
            if (gateway) return withMethod(gateway)
            exec('ip route show default 2>/dev/null', (e4, rto) => {
              const line = (rto || '').split('\n').find(l => l.includes(`dev ${iface}`))
              const gwm  = line && line.match(/default via (\d+\.\d+\.\d+\.\d+)/)
              if (gwm) return withMethod(gwm[1])
              exec(`sudo grep -r "via\\|gateway4" /etc/netplan/ 2>/dev/null`, (e5, npo) => {
                const vim  = (npo || '').match(/via:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
                const gw4m = (npo || '').match(/gateway4:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
                withMethod((vim || gw4m) ? (vim ? vim[1] : gw4m[1]) : null)
              })
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

/* -- WiFi -- */
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
  const { iface, dhcp, ip, mask, dns } = opts
  /* Le renderer (settings-network.js ? applyIfaceConfig) envoie la
     passerelle sous le nom "gateway", alors que ce handler lisait "gw"
     (toujours undefined) : la passerelle était donc écrasée par une
     chaîne vide à chaque application. On accepte les deux noms. */
  const gw = opts.gateway ?? opts.gw
  if (!iface) return false
  const cidr   = (mask || '255.255.255.0').split('.').reduce((a, o) => a + (parseInt(o) >>> 0).toString(2).split('1').length - 1, 0)
  const dnsList = (Array.isArray(dns) ? dns : String(dns || '').split(/[\s,]+/)).filter(Boolean)
  const dnsVal  = dnsList.length ? dnsList.join(' ') : '1.1.1.1 1.0.0.1'
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