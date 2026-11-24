# dshgo-dir-share

**DSH Go plugin** · Expose the DSH Go workspace directory over **FTP** and **WebDAV**, so **MT Manager** (or any FTP/WebDAV client) can mount it directly for reading and writing.

Pure Node.js — **zero third-party dependencies**. The FTP and WebDAV servers are implemented from scratch: no desktop required, no extra software on the LAN.

## Install MT Manager first

This plugin exists to serve MT Manager as network storage. If you don't have it:

| Channel | Link |
|---|---|
| Official site | <https://mt2.cn> |
| Direct APK (v2.26.11, build 26110366, 38.5 MB) | <https://pan.mt2.cn/apk/26110366> |
| Clone build (different package name, can coexist) | <https://pan.mt2.cn/apk/26110366/clone> |
| TargetSdk 28 build (needs exec permission) | <https://pan.mt2.cn/apk/26110366/target28> |
| App stores | search "MT管理器", package `bin.mt.plus` |

Requires Android 5.0+. Grant it storage access, otherwise the mount shows up but reads nothing.

> The direct APK link is the easiest route in mainland China — no VPN needed. The app-store build targets SDK 30, and the app's data directory no longer carries the exec permission.

## Install the plugin

Put the plugin directory into `$DSH_HOME/dsh-go/plugins/`, then add it to the current profile:

```bash
# 1. place it
cp -r <repo> "$DSH_HOME/dsh-go/plugins/local-dir-share"

# 2. add it to the profile (this machine uses `web`)
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-dir-share"

# 3. restart the engine: sidebar → Engine → Restart engine
```

After that: **Directory Share** appears under session details → **Plugins**, and under **All features → plugin groups**.

(The plugin deliberately adds no input-box capsule and no status bar — just the panel.)

## Usage

1. Open the **Directory Share** panel → **Start**
2. The panel shows the address, username and password → tap **Copy address**
3. MT Manager → top-left menu → **Network storage** → **Add network storage** → **FTP**

Fill in:

| Field | Value |
|---|---|
| Server | `127.0.0.1` (on the phone) or the LAN IP shown in the panel |
| Port | shown in the panel |
| Username / Password | shown in the panel |
| Encoding | UTF-8 |
| Root path | the workspace directory |

For WebDAV, pick **WebDAV** instead of FTP and use the `http://<address>:<port>/` URL from the panel.

## Why not just use a computer?

Because there isn't one. The point is to get files between the phone's AI agent and the rest of the world without dragging a laptop around: pull a dataset in, push a build out, edit a config from any FTP client.

## Security

- The server binds to the LAN only — it is not reachable from the internet
- Username/password are generated per start and shown in the panel
- Paths are normalised and confined to the shared root; `..` traversal is rejected

## License

MIT — see [LICENSE](LICENSE).
