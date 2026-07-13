#!/usr/bin/env python3
import sys, os, json, glob, time

try:
    import plyvel
except ImportError:
    sys.stderr.write("[xe] plyvel non disponible\n")
    sys.exit(0)

server    = sys.argv[1]
token     = sys.argv[2]
user_id   = sys.argv[3]
server_id = sys.argv[4]

origin = server.rstrip('/')

def ldb_key(name):
    return ('_' + origin + '\x00\x01' + name).encode('utf-8')

def ldb_val(s):
    return b'\x01' + s.encode('utf-8')

pattern = os.path.expanduser(
    '~/.var/app/org.jellyfin.JellyfinDesktop/data/jellyfin-desktop/profiles/*/QtWebEngine/Local Storage/leveldb'
)
candidates = glob.glob(pattern)

if not candidates:
    print('[xe] Aucun profil JellyfinDesktop trouvé', flush=True)
    sys.exit(0)

now_ms = int(time.time() * 1000)

creds = json.dumps({"Servers": [{
    "DateLastAccessed":  now_ms,
    "LastConnectionMode": 2,
    "ManualAddress":     origin,
    "manualAddressOnly": True,
    "Name":              "jellyfin",
    "Id":                server_id,
    "AccessToken":       token,
    "UserId":            user_id,
    "LocalAddress":      origin,
}]}, separators=(',', ':'))

for ldb_path in candidates:
    try:
        db = plyvel.DB(ldb_path)
        wb = db.write_batch()
        wb.put(ldb_key('jellyfin_credentials'), ldb_val(creds))
        wb.put(ldb_key('enableAutoLogin'),       ldb_val('true'))
        wb.put(ldb_key('layout'),                ldb_val('tv'))
        wb.write()
        db.close()
        print(f'[xe] LevelDB injecté: {ldb_path}', flush=True)
    except Exception as e:
        print(f'[xe] LevelDB erreur {ldb_path}: {e}', flush=True)
