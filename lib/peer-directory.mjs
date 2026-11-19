import {
  addPeerHistory,
  classifyUrl,
  deletePeerRecord,
  hostForUrl,
  readPeerRecords,
  rememberPeerRecord,
} from './peer-memory.mjs'

/**
 * Address memory for the bridge: which networks callers came from, plus the
 * "use this one" action that points this host at a remembered peer.
 */
export function createPeerDirectory({ getConfig, applyPatch, logger }) {
  const log = (level, message) => logger?.[level]?.(message)

  function config() {
    return getConfig?.() || {}
  }

  return {
    enabled() {
      return Boolean(config().rememberPeer)
    },

    record(rawHost) {
      const cfg = config()
      if (!cfg.rememberPeer) return null
      try {
        const record = rememberPeerRecord(cfg.stateDir, rawHost)
        if (record) log('info', `remembered peer ${record.host}`)
        return record
      } catch (error) {
        log('warn', `remembering peer failed: ${error?.message || error}`)
        return null
      }
    },

    noteAddress(peerUrl) {
      const cfg = config()
      const url = String(peerUrl || '').trim()
      if (!url) return cfg.peerHistory || {}
      let host = ''
      try {
        host = new URL(url.includes('://') ? url : `http://${url}`).hostname
      } catch {
        return cfg.peerHistory || {}
      }
      if (!classifyUrl(url)) return cfg.peerHistory || {}
      return addPeerHistory(cfg.peerHistory, host)
    },

    list() {
      const cfg = config()
      return {
        rememberPeer: Boolean(cfg.rememberPeer),
        listenPort: cfg.listenPort,
        records: readPeerRecords(cfg.stateDir),
      }
    },

    remove(mode) {
      const cfg = config()
      return deletePeerRecord(cfg.stateDir, mode)
    },

    async use(mode) {
      const cfg = config()
      const record = readPeerRecords(cfg.stateDir)[mode]
      if (!record) return { ok: false, error: `no remembered ${mode} address` }
      const peerUrl = `http://${hostForUrl(record.host)}:${cfg.listenPort}`
      await applyPatch({
        peerUrl,
        remoteMode: mode === 'tailnet' ? 'tailscale' : 'off',
        connectionMode: mode,
      })
      log('info', `switched to remembered ${mode} peer ${peerUrl}`)
      return { ok: true, mode, peerUrl, host: record.host }
    },
  }
}
