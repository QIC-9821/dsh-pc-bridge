# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
