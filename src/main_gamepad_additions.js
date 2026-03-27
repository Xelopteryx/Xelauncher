
// ── Gamepad maps ─────────────────────────────────────────────────────────
const INPUTMAPS_PATH = path.join(require('os').homedir(), '.var/app/com.github.iwalton3.jellyfin-media-player/data/jellyfinmediaplayer/inputmaps')
const EXAMPLES_PATH  = path.join(INPUTMAPS_PATH, 'examples')

ipcMain.handle('list-gamepad-maps', async () => {
  try {
    if (!fs.existsSync(INPUTMAPS_PATH)) return []
    const files = fs.readdirSync(INPUTMAPS_PATH).filter(f => f.endsWith('.json'))
    return files.map(file => {
      try {
        const raw = fs.readFileSync(path.join(INPUTMAPS_PATH, file), 'utf8')
        // JSON avec commentaires → on parse grossièrement
        const nameM   = raw.match(/"name"\s*:\s*"([^"]+)"/)
        const matcherM= raw.match(/"idmatcher"\s*:\s*"([^"]+)"/)
        return {
          file,
          name:      nameM    ? nameM[1]    : file,
          idmatcher: matcherM ? matcherM[1] : ''
        }
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
