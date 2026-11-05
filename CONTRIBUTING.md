# Contributing

Thanks for taking the time to improve `dsh-pc-bridge`.

## Development

Requirements: Node.js ≥ 22 (or the Node.js bundled with DeepSeek Harness).

```bash
git clone https://github.com/QIC-9821/dsh-pc-bridge.git
cd dsh-pc-bridge
npm test
node --check index.js
```

The plugin has **zero runtime dependencies** and that is intentional; please do
not add any. Tests use only `node:test`, `node:assert` and real loopback sockets.

To try the plugin locally, install the checkout as a bundle into a throwaway
profile:

```bash
dsh plugin --profile smoke add /absolute/path/to/dsh-pc-bridge
```

Do not install it next to the older startup-sync / pc-link scripts: two bridges
cannot bind the same port.

## Pull requests

- Keep one logical change per PR.
- Run `npm test` before pushing; CI runs Node 22 and 24.
- Update `README.md`, `README.en.md` and `CHANGELOG.md` when behaviour or config
  changes.
- Never commit secrets, private hostnames/keys, or personal paths. The bridge
  secret belongs in `$DSH_HOME/pc-bridge/secret`, never in the repository.
- Describe the threat-model impact of any change to `/exec`, auth, or the tunnel.

## Commit messages

Short imperative subject line, optional body explaining why. Examples:

```
fix: re-resolve the shell before every exec
docs: clarify tunnel setup
```

## Reporting bugs

Use the issue templates. Redact hostnames, usernames, secrets and keys from logs
before pasting. Security issues go through [SECURITY.md](SECURITY.md), not the
public issue tracker.
