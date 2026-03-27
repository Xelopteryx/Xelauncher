const { Level } = require('level')
const path = require('path')
const os = require('os')
const fs = require('fs')
const LS_PATH = path.join(
  os.homedir(),
  '.var/app/com.github.iwalton3.jellyfin-media-player/data/Jellyfin Media Player/QtWebEngine/Default/Local Storage/leveldb'
)

async function injectCredentials(server, serverId, token, userId) {
  fs.mkdirSync(LS_PATH, { recursive: true })
  const db = new Level(LS_PATH, { valueEncoding: 'buffer' })
  try {
    await db.open()

    const credentials = JSON.stringify({
      Servers: [{
        ManualAddress: server,
        LastConnectionMode: 2,
        Name: 'jellyfin',
        Id: serverId,
        DateLastAccessed: Date.now(),
        AccessToken: token,
        UserId: userId
      }]
    })

    const value = Buffer.concat([Buffer.from('\x01'), Buffer.from(credentials, 'utf8')])

    const existingKeys = []
    for await (const [key] of db.iterator()) { existingKeys.push(key) }
    console.log('Existing keys:', existingKeys.length)

    let injected = false
    for (const key of existingKeys) {
      if (key.toString('utf8').includes('jellyfin_credentials')) {
        await db.put(key, value)
        console.log('Updated existing key')
        injected = true
      }
    }

    if (!injected) {
      let serverOrigin = server
      try { serverOrigin = new URL(server).origin } catch(e) {}
      const keyBuf = Buffer.from('_' + serverOrigin + '\x00\x01jellyfin_credentials')
      await db.put(keyBuf, value)
      console.log('Created key for origin:', serverOrigin)
    }

    console.log('Done')
  } finally {
    await db.close()
  }
}

const [,, server, serverId, token, userId] = process.argv
if (!server || !token) {
  console.error('Usage: node inject-jellyfin-credentials.js <server> <serverId> <token> <userId>')
  process.exit(1)
}
injectCredentials(server, serverId, token, userId)
  .then(() => process.exit(0))
  .catch(err => { console.error('Error:', err.message); process.exit(1) })
