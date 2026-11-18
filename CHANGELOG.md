# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-18

### Added

- File channel on the bridge: `GET /file/stat`, `GET /file/list`,
  `GET /file/read` and `POST /file/write`, all behind the same shared secret.
  Reads are paged and carry a per-chunk sha256; writes accept chunked uploads
  into `<target>.pcbridge-<uploadId>.part` and rename into place only after the
  last chunk's whole-file sha256 matches (`append` and `createDirs` supported).
- `lib/file.mjs`: path resolution confined to `fileRoots` via `realpath` of the
  deepest existing ancestor, so a symlink/junction inside a root cannot be used
  to write outside it; `FILE_LIMITS` bounds the chunk and file sizes.
- Three tools, registered only while `fileToolsEnabled` is on:
  `pc_file_list`, `pc_file_read` (inline paged read, or download via `dest`) and
  `pc_file_write` (inline ≤ 1 MiB, or upload via `source`).
- Settings page: a second tab **文件传输** inside the 电脑执行桥 section — the
  file-tools switch (`fileToolsEnabled`, off by default so the schemas cost
  nothing per turn), the peer-access switch (`fileEnabled`), `fileRoots` (one
  per line), chunk/size limits, and a self-test button
  (`POST /pc-bridge/api/file-test`) that writes, reads, stats and deletes a temp
  file locally.
- `pcctl file list|stat|get|put`, including `--out`, `--overwrite` and `--peer`.
- `GET /info` exposes `file.enabled` and `file.chunkBytes`; `/health`
  capabilities gain `file` while the channel is on (they drop it when
  `fileEnabled` is off, and the routes then answer 404).

### Changed

- `applyPatch` treats `toolsMode` and `fileToolsEnabled` as registry-only
  settings: the settings file is written, the config reloaded and the tool table
  re-registered **without** restarting the listener.
- Audit entries of kind `file` record `op`, `path`, `bytes`, `ok`, `ms` and `ip`
  — never file contents, and failed operations are recorded too.

## [0.4.1] - 2026-11-18

### Fixed

- Settings page turned completely blank after a restart: the connection-mode
  card rendered a `Choice` radio component that no longer existed. Restored it,
  so the section renders again.
- Buttons were disabled whenever any action was running, so a stuck request
  could leave "保存并应用" unclickable with no feedback. Each button now only
  disables itself while its own action runs.

## [0.4.0] - 2026-11-17

### Added

- `lib/warp.mjs`: wraps `warp-cli` — reads `status` / `settings`, classifies
  tunnel modes and switches between DNS-only (`doh`) and the full tunnel.
- `lib/tailscale.mjs`: reads `tailscale status --json`, picks the tailnet IPv4
  address and builds the remote URL; degrades gracefully when Tailscale is
  absent or signed out.
- `GET /pc-bridge/api/warp` (WARP, Tailscale and remote-URL state) and
  `POST /pc-bridge/api/warp` with `{action: "dns-only" | "tunnel" | "status"}`.
- `remoteMode: tailscale`: the listener binds the tailnet address itself (so the
  Wi-Fi / hotspot interfaces stay closed) and falls back to `0.0.0.0` when
  Tailscale is offline or that address cannot be bound; the settings page shows
  the tailnet remote URL and `pc_ping` / `pc_exec` stay registered.
- `warpCoexist` (default `true`, honoured only with `remoteMode: tailscale`):
  when WARP is in a tunnel mode at start, switch it with `warp-cli mode doh` so
  Tailscale's control connection survives; `false` never touches WARP.
- Settings page network card: Tailscale online state, tailnet address, copyable
  remote URL, buttons for "WARP DNS-only (coexist)" / "restore WARP tunnel" /
  "refresh network state", and the `warpCoexist` checkbox.

### Changed

- README (Chinese and English): remote (Tailscale) and WARP sections, the
  connection table and the config table.
- Test suite covers the Tailscale and WARP clients, tailnet binding and the
  network-check lifecycle — 138 tests.

### Fixed

- `warp-cli settings` prints human-readable mode names (`DnsOverHttps`,
  `WarpWithDnsOverHttps`, …); they are now normalised, so a `warp+doh` tunnel
  is recognised and switched instead of being mistaken for "nothing to do".
- The post-start network check is stored, cleared on stop and generation-guarded,
  so stopping or restarting the bridge cannot leave a stray `warp-cli` run.
- A failed WARP switch no longer reports `installed: false`; it keeps the real
  state, records an audit entry and surfaces the error.
- "Restore WARP tunnel" puts back the previously recorded mode instead of always
  forcing plain `warp` (which would silently drop a DoH/DoT choice).
- The remote URL is only produced for a running, non-client bridge whose
  Tailscale is online; `ssh` mode and stopped bridges no longer show a LAN
  address that cannot be reached.
- The built-in tools dial the address the server actually bound, so a
  tailnet-only listener still works from the local agent.
- Tests inject fake WARP/Tailscale clients; the suite no longer touches the
  machine's real VPN.

## [0.3.1] - 2026-11-17

### Added

- Master switch `enabled` with a settings-page card. Turning it off keeps the
  plugin and its settings page loaded but stops the HTTP listener, UDP
  discovery and `pc_ping` / `pc_exec` registration (`POST /pc-bridge/api/enabled`).
- Pairing memory: `peerName` / `peerPlatform` / `peerTransport` /
  `peerPairedAt` / `peerFingerprint` plus a `pairings` history (up to 10,
  deduped by address, newest first). The page shows the paired peer and offers a
  "disconnect" action (`POST /pc-bridge/api/pair/clear`).
- Custom `secretFile` in the advanced card. Changing it migrates the secret:
  write the new file (mode 600) → verify it → persist the setting → restart →
  delete the old file; a failed delete only warns. Migration is refused while
  the effective secret comes from the plugin config or an environment variable.
- "Delete local data" action and `POST /pc-bridge/api/cleanup` (`{confirm:true}`)
  which remove the secret, `settings.json`, `audit.jsonl*` and `bridge.log*`.
- Experimental `purgeOnUninstall`: on teardown, delete that data when the profile
  no longer lists this plugin. DSH has no public uninstall hook, so the in-page
  cleanup stays the reliable path.

### Changed

- `applyPatch` now returns `{status, warnings}` and the settings API surfaces
  those warnings; a secret-file migration and the rest of a patch are applied
  with one settings write and one restart.
- Switching the connection mode no longer clears a paired `peerUrl`.
- `POST /pair` responses include the host's `name` and `platform`, so the
  joining side can label the peer.
- `status` gained `enabled`, `connected`, `lastPeerCheckAt`, `peer` and
  `pairingsCount`; the bridge pings a configured peer 3 s after start without
  blocking.
- The settings page master switch applies immediately through
  `POST /api/enabled`; it is no longer a draft field that needs the save button.
- Removed the redundant start/stop buttons from the page footer; the save button
  is now labelled "保存并应用" and explains that only the bridge listener
  restarts, never DSH.
- The tools card is one checkbox ("没配对端时也注册 pc_ping / pc_exec") instead
  of the auto/always/off radio group; `off` is still accepted from old settings
  but no longer offered.
- The secret-file help text says the bridge restarts in-process (milliseconds);
  no software restart is needed.

## [0.3.0] - 2026-11-17

### Added

- Settings page **设置 → 电脑执行桥** (`client.js`): live status, connection mode
  (loopback / LAN / custom `peerUrl`), address list with copy, nearby-device
  discovery, pairing-code flow, tools mode, advanced limits and the audit tail.
- Local settings API under `/pc-bridge/api/*` (state, config, start/stop/restart,
  test, discover, pair/new, pair/accept, secret/rotate, audit).
- Persistent settings file `$DSH_HOME/pc-bridge/settings.json`: whitelisted,
  validated, atomically written, and wins over the plugin config.
- LAN access: `listenHost: 0.0.0.0`, `GET /health` and `GET /info`, plus
  `POST /pair` with a 6-digit single-use code (TTL 300 s, 5 failures per IP lock
  the code for 10 minutes).
- UDP discovery on port 18791 (`DSHBRIDGE/1`): a host answers name, platform,
  version and its HTTP port; scanning dedupes by peer identity.
- Audit log `audit.jsonl` (start/stop/restart/config/pair/exec/secret), rotated
  at 1 MB with `auditKeep` generations.
- `toolsMode: auto | always | off` and `remoteMode`, so `pc_ping` / `pc_exec`
  are only registered when they are useful (about 0.3k tokens saved per turn).
- `listenPort: 0` picks a free port (tests and `restart` friendly).

### Changed

- `index.js` now owns a `runtime` object instead of wiring everything in `apply`;
  a busy port leaves the bridge in `error` state without crashing the plugin.
- Oversized request bodies get a clean `413` instead of a destroyed socket.
- Tool descriptions were shortened; the tool schema is unchanged.

### Fixed

- Pairing and secret rotation now refuse to run when the effective secret comes
  from the plugin config or an environment variable (the written file would
  otherwise be ignored).

## [0.2.0] - 2026-11-07

### Added

- Android support: shell discovery uses Termux bash (`$PREFIX/bin/bash`) or the
  platform `/system/bin/sh`, and a timeout kills the whole process group
  (`process.kill(-pid)`) instead of relying on `taskkill`.
- `peer` parameter on `pc_ping` / `pc_exec`, so one machine can reach another
  bridge at a changing LAN address (tablet on a different Wi-Fi).
- Inline `secret` config field, for hosts whose cordis patch is the only place a
  shared secret can be provisioned (Android app stores no external file).
## [0.1.1] - 2026-11-06

### Added

- README demo screenshots: a real `pc_ping` reply and a real `pc_exec` run
  against the host machine.

## [0.1.0] - 2026-11-05

First public release.

### Added

- Loopback HTTP bridge (`127.0.0.1:18790` by default) with `GET|POST /ping` and
  `POST /exec`, authenticated by an `x-pc-secret` header.
- `pc_ping` and `pc_exec` agent tools, plus a standalone `pcctl` CLI.
- Secret auto-generation on first start (32 random bytes, file mode 600).
- Command timeout with process-tree termination, and a bounded output buffer.
- Optional ssh reverse-tunnel supervisor with 5/10/30/60 s backoff and stale
  remote-port recovery (`fuser -k`) before rebinding.
- Shell discovery that prefers Git Bash on Windows and re-validates the cached
  path before every execution.
- Tests covering the HTTP surface, auth, timeout, and config normalization.
