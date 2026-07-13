#!/usr/bin/env python3
import sys, os, json
try:
    import plyvel
except ImportError:
    sys.stderr.write("[xe] plyvel non disponible, injection LevelDB ignorée\n")
    sys.exit(0)

server    = sys.argv[1]
token     = sys.argv[2]
user_id   = sys.argv[3]
server_id = sys.argv[4]

ldb_candidates = [
    os.path.expanduser('~/.var/app/com.github.iwalton3.jellyfin-media-player/data/Jellyfin Media Player/QtWebEngine/Default/Local Storage/leveldb'),
    os.path.expanduser('~/.local/share/Jellyfin Media Player/QtWebEngine/Default/Local Storage/leveldb'),
]

creds = json.dumps({"Servers": [{
    "ManualAddress":      server,
    "manualAddressOnly":  True,
    "Name":               "jellyfin",
    "Id":                 server_id,
    "UserId":             user_id,
    "AccessToken":        token,
    "LastConnectionMode": 2,
    "LastLocalAddress":   server,
    "DateLastAccessed":   9999999999999,
}]})

# Format LevelDB QtWebEngine : clé = "_<origin>\x00\x01<key>", valeur = "\x01<value>"
host  = server.split('://', 1)[-1]
key   = ('_http://' + host + '\x00\x01jellyfin_credentials').encode()
value = b'\x01' + creds.encode()

injected = 0
for ldb_path in ldb_candidates:
    if not os.path.exists(ldb_path):
        continue
    try:
        db = plyvel.DB(ldb_path)
        db.put(key, value)
        db.close()
        injected += 1
        print(f'[xe] LevelDB injecté: {ldb_path}', flush=True)
    except Exception as e:
        print(f'[xe] LevelDB erreur {ldb_path}: {e}', flush=True)

if injected == 0:
    print('[xe] Aucun LevelDB trouvé — l\'URL CLI prend le relais', flush=True)
