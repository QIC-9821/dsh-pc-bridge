# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
