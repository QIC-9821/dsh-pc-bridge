# Security policy

## Supported versions

The latest `0.1.x` release receives fixes. Please upgrade before reporting an
issue.

## What this plugin does (threat model)

`dsh-pc-bridge` is a **remote shell**, by design. Treat the secret like an SSH
key:

- It listens on a loopback address (`127.0.0.1:18790` by default). Anyone who
  can reach that port **and** knows the `x-pc-secret` value can run arbitrary
  shell commands **as your user** through `POST /exec`.
- The secret is generated on first start into `$DSH_HOME/pc-bridge/secret`
  (mode 600). Do not commit it, paste it into an issue, or reuse it elsewhere.
- Never bind to `0.0.0.0` or expose the port to the internet. If a remote peer
  needs access, use the built-in ssh reverse tunnel (or your own tunnel) and
  restrict it to that peer.
- The optional tunnel runs `ssh -N -R` to `sshHost`; the remote side can then
  reach this loopback port. Secure the remote account and its authorized keys.
- `POST /exec` runs the command through a shell (`bash`/`cmd`), with a timeout;
  on timeout the spawned process tree is killed. Output is capped and returned
  verbatim — it is not redacted.
- The plugin writes no telemetry and opens no other sockets.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private advisory form:

https://github.com/QIC-9821/dsh-pc-bridge/security/advisories/new

Include the version, platform, configuration (redacted), and a minimal
reproduction. You should get an initial reply within a week.

## Handling secrets

- Keep `secret` and ssh keys outside the repository.
- Before pasting logs into an issue, remove hostnames, usernames, paths and
  command output that may contain sensitive data.
