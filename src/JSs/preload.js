/**
 * XeLauncher — preload.js
 * Exposes safe IPC bridge to renderer processes.
 */

const { contextBridge, ipcRenderer } = require('electron')

console.log('Preload script loaded')

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
  launchJellyfinWithToken: (server, token, userId, serverId, username, password) => ipcRenderer.invoke('launch-jellyfin-token', server, token, userId, serverId, username, password),

  /* Jellyfin auth */
  jellyfinAuthenticate:    (server, user, pass)     => ipcRenderer.invoke('jellyfin-authenticate', server, user, pass),

  /* Profiles */
  getProfiles:             ()                       => ipcRenderer.invoke('get-profiles'),
  saveProfile:             (profile)                => ipcRenderer.invoke('save-profile', profile),
  deleteProfile:           (id)                     => ipcRenderer.invoke('delete-profile', id),
  saveServer:              (serverUrl)              => ipcRenderer.invoke('save-server', serverUrl),
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
  getDisplayModes:         ()                       => ipcRenderer.invoke('get-display-modes'),
  setDisplay:              (opts)                   => ipcRenderer.invoke('set-display', opts),
  setAudio:                (opts)                   => ipcRenderer.invoke('set-audio', opts),
  getAudioSinks:           ()                       => ipcRenderer.invoke('get-audio-sinks'),
  debugAudio:              ()                       => ipcRenderer.invoke('debug-audio'),

  /* Network */
  getInterfaces:           ()                       => ipcRenderer.invoke('get-interfaces'),
  getIpAddresses:          ()                       => ipcRenderer.invoke('get-ip-addresses'),
  wifiScan:                ()                       => ipcRenderer.invoke('wifi-scan'),
  wifiConnect:             (ssid, pwd)              => ipcRenderer.invoke('wifi-connect', ssid, pwd),
  wifiForget:              (ssid)                   => ipcRenderer.invoke('wifi-forget', ssid),
  wifiDisconnect:          ()                       => ipcRenderer.invoke('wifi-disconnect'),
  wifiCurrentSSID:         ()                       => ipcRenderer.invoke('wifi-current-ssid'),
  getKnownNetworks:        ()                       => ipcRenderer.invoke('wifi-get-known'),
  setKnownNetworksPriority:(ssids)                  => ipcRenderer.invoke('wifi-set-priority', ssids),
  setStaticIp:             (opts)                   => ipcRenderer.invoke('set-static-ip', opts),

  /* Bluetooth — commandes */
  btListPaired:            ()                       => ipcRenderer.invoke('bt-list-paired'),
  btScanStart:             ()                       => ipcRenderer.invoke('bt-scan-start'),
  btScanStop:              ()                       => ipcRenderer.invoke('bt-scan-stop'),
  btPair:                  (mac, type)              => ipcRenderer.invoke('bt-pair', mac, type),
  btConnect:               (mac)                    => ipcRenderer.invoke('bt-connect', mac),
  btDisconnect:            (mac)                    => ipcRenderer.invoke('bt-disconnect', mac),
  btRemove:                (mac)                    => ipcRenderer.invoke('bt-remove', mac),
  btRename:                (mac, name)              => ipcRenderer.invoke('bt-rename', mac, name),
  btStatus:                ()                       => ipcRenderer.invoke('bt-status'),
  btPower:                 (on)                     => ipcRenderer.invoke('bt-power', on),
  btDiagnose:              (mac, type)              => ipcRenderer.invoke('bt-diagnose', mac, type),
  btNames:                 ()                       => ipcRenderer.invoke('bt-names'),
  btInputReady:            (mac, timeoutMs)         => ipcRenderer.invoke('bt-input-ready', mac, timeoutMs),
  btAudioFix:              (mac)                    => ipcRenderer.invoke('bt-audio-fix', mac),

  /* Bluetooth — événements (un seul écouteur actif par canal) */
  onBtScanDevice:          (cb) => { ipcRenderer.removeAllListeners('bt-scan-device');    ipcRenderer.on('bt-scan-device',    (_, d) => cb(d)) },
  onBtScanDone:            (cb) => { ipcRenderer.removeAllListeners('bt-scan-done');      ipcRenderer.on('bt-scan-done',      (_, p) => cb(p)) },
  offBtScan:               ()   => { ipcRenderer.removeAllListeners('bt-scan-device');    ipcRenderer.removeAllListeners('bt-scan-done') },
  onBtPairProgress:        (cb) => { ipcRenderer.removeAllListeners('bt-pair-progress');  ipcRenderer.on('bt-pair-progress',  (_, p) => cb(p)) },
  offBtPairProgress:       ()   => ipcRenderer.removeAllListeners('bt-pair-progress'),

  isAvailable:             ()                       => true,
  saveCalibration:         (data)                   => ipcRenderer.invoke('save-calibration', data),

  /* xe_input daemon — evdev universel */
  onXeInputEvent: (cb) => { ipcRenderer.removeAllListeners('xe-input-event'); ipcRenderer.on('xe-input-event', (_, data) => cb(data)); },
  offXeInputEvent:         ()                       => ipcRenderer.removeAllListeners('xe-input-event'),
  onXeInputRelease: (cb) => { ipcRenderer.removeAllListeners('xe-input-release'); ipcRenderer.on('xe-input-release', (_, data) => cb(data)); },
  offXeInputRelease:       ()                       => ipcRenderer.removeAllListeners('xe-input-release'),
  xeInputStatus:           ()                       => ipcRenderer.invoke('xe-input-status'),

  /* Mapping Jellyfin — persisté sur disque pour xe_jmp_input.py */
  saveJfMapping:           (mapping)                => ipcRenderer.invoke('save-jf-mapping', mapping),
  loadJfMapping:           ()                       => ipcRenderer.invoke('load-jf-mapping'),

  /* Signale au main process que le renderer est visuellement prêt */
  rendererReady:           ()                       => ipcRenderer.send('renderer-ready'),
})