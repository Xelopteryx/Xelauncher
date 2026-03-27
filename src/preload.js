const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xeLauncher', {
  // ── Navigation ────────────────────────────────────────────────────────
  launchRetropie:          () => ipcRenderer.invoke('launch-retropie'),
  launchJellyfin:          () => ipcRenderer.invoke('launch-jellyfin'),
  launchJellyfinWithToken: (server, token, userId, serverId) => ipcRenderer.invoke('launch-jellyfin-token', server, token, userId, serverId),
  goBack:                  () => ipcRenderer.invoke('go-back'),
  openSettings:            () => ipcRenderer.invoke('open-settings'),
  openMenu:                () => ipcRenderer.invoke('go-back'),

  // ── Système ───────────────────────────────────────────────────────────
  systemUpdate:            () => ipcRenderer.invoke('system-update'),
  systemReboot:            () => ipcRenderer.invoke('system-reboot'),
  systemShutdown:          () => ipcRenderer.invoke('system-shutdown'),
  getVersion:              () => ipcRenderer.invoke('get-version'),
  checkUpdate:             () => ipcRenderer.invoke('check-update'),

  // ── Réseau ────────────────────────────────────────────────────────────
  getInterfaces:           () => ipcRenderer.invoke('get-interfaces'),
  getIpAddresses:          () => ipcRenderer.invoke('get-ip-addresses'),
  wifiScan:                () => ipcRenderer.invoke('wifi-scan'),
  wifiConnect:             (ssid, pwd) => ipcRenderer.invoke('wifi-connect', ssid, pwd),
  wifiForget:              (ssid) => ipcRenderer.invoke('wifi-forget', ssid),
  wifiCurrentSSID:         () => ipcRenderer.invoke('wifi-current-ssid'),

  // ── Affichage / Audio ─────────────────────────────────────────────────
  setDisplay:              (opts) => ipcRenderer.invoke('set-display', opts),
  setAudio:                (opts) => ipcRenderer.invoke('set-audio', opts),

  // ── Manette ───────────────────────────────────────────────────────────
  setControllerType:       (type) => ipcRenderer.invoke('set-controller-type', type),
  setStaticIp:             (opts) => ipcRenderer.invoke('set-static-ip', opts),

  // ── Jellyfin auth (via process principal, pas fetch renderer) ──────────
  jellyfinAuthenticate:    (server, username, password) => ipcRenderer.invoke('jellyfin-authenticate', server, username, password),

  // ── Profils / Avatars ─────────────────────────────────────────────────
  getProfiles:             () => ipcRenderer.invoke('get-profiles'),
  saveProfile:             (profile) => ipcRenderer.invoke('save-profile', profile),
  deleteProfile:           (id) => ipcRenderer.invoke('delete-profile', id),
  getAvatars:              () => ipcRenderer.invoke('get-avatars'),
  getAvatarData:           (filename) => ipcRenderer.invoke('get-avatar-data', filename),

  // ── Ajout: vérification de disponibilité ──────────────────────────────
  // ── Config ────────────────────────────────────────────────────────────
  getConfig:               () => ipcRenderer.invoke('get-config'),

  // ── Bluetooth ─────────────────────────────────────────────────────────
  btListPaired:            () => ipcRenderer.invoke('bt-list-paired'),
  btScan:                  () => ipcRenderer.invoke('bt-scan'),
  btPair:                  (mac) => ipcRenderer.invoke('bt-pair', mac),
  btConnect:               (mac) => ipcRenderer.invoke('bt-connect', mac),
  btDisconnect:            (mac) => ipcRenderer.invoke('bt-disconnect', mac),
  btRemove:                (mac) => ipcRenderer.invoke('bt-remove', mac),
  btRename:                (mac, name) => ipcRenderer.invoke('bt-rename', mac, name),
  btStatus:                () => ipcRenderer.invoke('bt-status'),
  btPower:                 (on) => ipcRenderer.invoke('bt-power', on),

  // ── Gamepad mapping ───────────────────────────────────────────────────
  listGamepadMaps:         () => ipcRenderer.invoke('list-gamepad-maps'),
  saveGamepadMap:          (filename, content) => ipcRenderer.invoke('save-gamepad-map', filename, content),
  deleteGamepadMap:        (filename) => ipcRenderer.invoke('delete-gamepad-map', filename),
  activateGamepadExamples: () => ipcRenderer.invoke('activate-gamepad-examples'),

  openGamepadTester:       () => ipcRenderer.invoke('open-gamepad-tester'),
  wiimoteRescan:           () => ipcRenderer.invoke('wiimote-rescan'),
  onWiimoteDpad:           (cb) => ipcRenderer.on('wiimote-dpad', (_, evt) => cb(evt)),
  offWiimoteDpad:          ()   => ipcRenderer.removeAllListeners('wiimote-dpad'),

  isAvailable:             () => true
})