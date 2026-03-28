/**
 * XeLauncher — preload.js
 * Exposes safe IPC bridge to renderer processes.
 */

const { contextBridge, ipcRenderer } = require('electron')

console.log('Preload script loaded')

// Expose a debug function
contextBridge.exposeInMainWorld('debug', {
  log: (...args) => console.log('[Renderer]', ...args),
  error: (...args) => console.error('[Renderer]', ...args)
})

contextBridge.exposeInMainWorld('xeLauncher', {
  /* Navigation */
  goBack:                  ()                       => ipcRenderer.invoke('go-back'),
  openSettings:            ()                       => ipcRenderer.invoke('open-settings'),
  launchRetropie:          ()                       => ipcRenderer.invoke('launch-retropie'),
  launchJellyfin:          ()                       => ipcRenderer.invoke('launch-jellyfin'),
  launchJellyfinWithToken: (server, token, userId)  => ipcRenderer.invoke('launch-jellyfin-token', server, token, userId),

  /* Jellyfin auth */
  jellyfinAuthenticate:    (server, user, pass)     => ipcRenderer.invoke('jellyfin-authenticate', server, user, pass),

  /* Profiles */
  getProfiles:             ()                       => ipcRenderer.invoke('get-profiles'),
  saveProfile:             (profile)                => ipcRenderer.invoke('save-profile', profile),
  deleteProfile:           (id)                     => ipcRenderer.invoke('delete-profile', id),
  getAvatars:              ()                       => ipcRenderer.invoke('get-avatars'),
  getAvatarData:           (filename)               => ipcRenderer.invoke('get-avatar-data', filename),

  /* System */
  systemReboot:            ()                       => ipcRenderer.invoke('system-reboot'),
  systemShutdown:          ()                       => ipcRenderer.invoke('system-shutdown'),
  systemUpdate:            ()                       => ipcRenderer.invoke('system-update'),
  getVersion:              ()                       => ipcRenderer.invoke('get-version'),
  checkUpdate:             ()                       => ipcRenderer.invoke('check-update'),
  getConfig:               ()                       => ipcRenderer.invoke('get-config'),
  setControllerType:       (type)                   => ipcRenderer.invoke('set-controller-type', type),

  /* Display / Audio */
  setDisplay:              (opts)                   => ipcRenderer.invoke('set-display', opts),
  setAudio:                (opts)                   => ipcRenderer.invoke('set-audio', opts),

  /* Network */
  getInterfaces:           ()                       => ipcRenderer.invoke('get-interfaces'),
  getIpAddresses:          ()                       => ipcRenderer.invoke('get-ip-addresses'),
  wifiScan:                ()                       => ipcRenderer.invoke('wifi-scan'),
  wifiConnect:             (ssid, pwd)              => ipcRenderer.invoke('wifi-connect', ssid, pwd),
  wifiForget:              (ssid)                   => ipcRenderer.invoke('wifi-forget', ssid),
  wifiCurrentSSID:         ()                       => ipcRenderer.invoke('wifi-current-ssid'),
  setStaticIp:             (opts)                   => ipcRenderer.invoke('set-static-ip', opts),

  /* Bluetooth */
  btListPaired:            ()                       => ipcRenderer.invoke('bt-list-paired'),
  btScan:                  ()                       => ipcRenderer.invoke('bt-scan'),
  btPair:                  (mac)                    => ipcRenderer.invoke('bt-pair', mac),
  btConnect:               (mac)                    => ipcRenderer.invoke('bt-connect', mac),
  btDisconnect:            (mac)                    => ipcRenderer.invoke('bt-disconnect', mac),
  btRemove:                (mac)                    => ipcRenderer.invoke('bt-remove', mac),
  btRename:                (mac, name)              => ipcRenderer.invoke('bt-rename', mac, name),
  btStatus:                ()                       => ipcRenderer.invoke('bt-status'),
  btPower:                 (on)                     => ipcRenderer.invoke('bt-power', on),

  isAvailable:             ()                       => true
})