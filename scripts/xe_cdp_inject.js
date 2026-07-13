#!/usr/bin/env node
'use strict';
// xe_cdp_inject.js — généré par ipc-jellyfin.js, lancé en processus détaché
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');

const LOG_FILE = require('path').join(require('os').tmpdir(), 'xe_cdp_inject.log');
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch(_) {}
}

const { server, token, userId, serverId } = {"server":"http://100.111.157.87:8097","token":"7bae187b2628413f9f324a1b15eee85a","userId":"76ef05faf1434924a96b92db9259cd2d","serverId":"5bdfc004a5ce4e63bd2fb023148957e6"};

const CDP_PORT   = 9222;
const MAX_WAIT   = 60000;
const POLL_DELAY = 600;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON invalide')); } });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len     = payload.length;
  const mask    = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; header[1] = 0x80 | len; mask.copy(header, 2);
  } else {
    header = Buffer.alloc(8);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2); mask.copy(header, 4);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  socket.write(Buffer.concat([header, masked]));
}

function cdpSession(wsPath, port, callback) {
  return new Promise((resolve, reject) => {
    const socket  = new net.Socket();
    let   msgId   = 1;
    const pending = new Map();
    let   buf     = Buffer.alloc(0);
    let   handshakeDone = false;
    const wsKey = crypto.randomBytes(16).toString('base64');

    socket.connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${wsPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13', '\r\n',
      ].join('\r\n'));
    });

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshakeDone = true;
        buf = buf.slice(idx + 4);
        const send = (method, params = {}) => new Promise((res, rej) => {
          const id = msgId++;
          pending.set(id, { resolve: res, reject: rej });
          wsSend(socket, JSON.stringify({ id, method, params }));
        });
        Promise.resolve()
          .then(() => callback(send))
          .then(() => { socket.destroy(); resolve(); })
          .catch(e => { socket.destroy(); reject(e); });
        if (buf.length > 0) processFrames();
        return;
      }
      processFrames();
    });

    socket.on('error', reject);
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('CDP WebSocket timeout')); });

    function processFrames() {
      while (buf.length >= 2) {
        const opcode     = buf[0] & 0x0f;
        const masked     = (buf[1] & 0x80) !== 0;
        let   payloadLen = buf[1] & 0x7f;
        let   offset     = 2;
        if (payloadLen === 126) { if (buf.length < 4) break; payloadLen = buf.readUInt16BE(2); offset = 4; }
        else if (payloadLen === 127) { if (buf.length < 10) break; payloadLen = buf.readUInt32BE(6); offset = 10; }
        const maskSize  = masked ? 4 : 0;
        const totalSize = offset + maskSize + payloadLen;
        if (buf.length < totalSize) break;
        const maskBytes  = masked ? buf.slice(offset, offset + 4) : null;
        const rawPayload = buf.slice(offset + maskSize, totalSize);
        buf = buf.slice(totalSize);
        let pl = rawPayload;
        if (masked) { pl = Buffer.alloc(rawPayload.length); for (let i=0;i<rawPayload.length;i++) pl[i]=rawPayload[i]^maskBytes[i%4]; }
        if (opcode === 1) {
          try {
            const msg = JSON.parse(pl.toString('utf8'));
            if (msg.id !== undefined && pending.has(msg.id)) {
              const { resolve: res, reject: rej } = pending.get(msg.id);
              pending.delete(msg.id);
              if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
              else res(msg.result);
            }
          } catch(_) {}
        } else if (opcode === 8) { socket.destroy(); }
      }
    }
  });
}

async function main() {
  log('CDP injector démarré');
  const deadline = Date.now() + MAX_WAIT;

  // Attendre que JMP expose son endpoint CDP
  let pages = null;
  let page = null;
  while (Date.now() < deadline) {
    try {
      const p = await httpGetJSON(`http://localhost:${CDP_PORT}/json`);
      if (Array.isArray(p) && p.length > 0) {
        const candidate = p.find(pg => pg.type === 'page') || p[0];
        const url = candidate.url || '';
        if (url && url !== 'about:blank' && !url.startsWith('data:')) {
          pages = p; page = candidate; break;
        }
      }
    } catch(_) {}
    await sleep(POLL_DELAY);
  }
  if (!pages) { log('CDP: /json non disponible après ' + MAX_WAIT + 'ms, abandon'); process.exit(1); }

  log('CDP: page trouvée — ' + page.title + ' (' + (page.url||'') + ')');

  const u      = new URL(page.webSocketDebuggerUrl);
  const wsPath = u.pathname + u.search;

  const creds = JSON.stringify({
    Servers: [{
      DateLastAccessed:   Date.now(),
      LastConnectionMode: 2,
      ManualAddress:      server,
      manualAddressOnly:  true,
      Id:                 serverId || 'xelauncher',
      AccessToken:        token,
      UserId:             userId  || '',
      Name:               'Jellyfin',
      LocalAddress:       server,
    }]
  });

  const jsInject = [
    `localStorage.clear()`,
    `sessionStorage.clear()`,
    `(function(){try{indexedDB.databases().then(function(dbs){dbs.forEach(function(db){indexedDB.deleteDatabase(db.name)})})}catch(e){}})() `,
    `localStorage.setItem('jellyfin_credentials', ${JSON.stringify(creds)})`,
    `localStorage.setItem('layout', 'tv')`,
    `localStorage.setItem('enableGamepad', 'true')`,
    `'injected'`,
  ].join(';');

  // 1ère injection + reload
  await cdpSession(wsPath, CDP_PORT, async send => {
    log('CDP: 1ère injection...');
    const r = await send('Runtime.evaluate', { expression: jsInject, returnByValue: true });
    log('CDP: eval #1 — ' + JSON.stringify(r?.result));
    log('CDP: reload...');
    await send('Page.reload', { ignoreCache: true });
  });

  // Attendre stabilisation post-reload
  log('CDP: attente stabilisation post-reload (3s)...');
  await sleep(3000);

  // Retrouver la page après reload
  let pages2 = null;
  const dl2 = Date.now() + 10000;
  while (Date.now() < dl2) {
    try {
      const p = await httpGetJSON(`http://localhost:${CDP_PORT}/json`);
      if (Array.isArray(p) && p.length > 0) { pages2 = p; break; }
    } catch(_) {}
    await sleep(POLL_DELAY);
  }
  if (!pages2) { log('CDP: page introuvable après reload, abandon'); process.exit(0); }

  const page2  = pages2.find(p => p.type === 'page') || pages2[0];
  const u2     = new URL(page2.webSocketDebuggerUrl);
  const wsPath2 = u2.pathname + u2.search;

  // 2ème injection + navigation vers home
  await cdpSession(wsPath2, CDP_PORT, async send => {
    log('CDP: 2ème injection (post-reload)...');
    const r = await send('Runtime.evaluate', { expression: jsInject, returnByValue: true });
    log('CDP: eval #2 — ' + JSON.stringify(r?.result));
    const jsNav = `(function(){
      var h=window.location.hash;
      if(h&&h.indexOf('login')===-1&&h.indexOf('selectserver')===-1) return 'already-home';
      window.location.hash='#!/home.html'; return 'navigated';
    })()`;
    const r2 = await send('Runtime.evaluate', { expression: jsNav, returnByValue: true });
    log('CDP: nav — ' + JSON.stringify(r2?.result));
  });

  log('CDP: injection terminée avec succès');
  process.exit(0);
}

main().catch(e => { log('CDP: erreur fatale — ' + e.message); process.exit(1); });
