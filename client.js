window.__ModuleLoader__.load({
  id: 'dsh-pc-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/pc-bridge/api/'

    const CARD = {
      border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 14,
      background: 'var(--dsh-surface, transparent)',
    }
    const LABEL = { fontSize: 12.5, opacity: 0.7, marginBottom: 4 }
    const INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }
    const BUTTON = {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    }
    const PRIMARY = {
      ...BUTTON,
      background: 'var(--dsh-accent, #3b82f6)',
      borderColor: 'var(--dsh-accent, #3b82f6)',
      color: '#fff',
    }
    const MUTED = { fontSize: 12.5, opacity: 0.65 }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }
    const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }

    async function api(path, options) {
      const response = await fetch(API + path, options)
      const text = await response.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        value = { error: text || `HTTP ${response.status}` }
      }
      if (!response.ok || value?.ok === false) {
        throw new Error(value?.error || value?.result?.error || `HTTP ${response.status}`)
      }
      return value
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    function Card(props) {
      return h('div', { style: CARD }, [
        h('div', { key: 'title', style: { fontSize: 13.5, fontWeight: 600, marginBottom: 10 } }, props.title),
        ...(Array.isArray(props.children) ? props.children : [props.children]),
      ])
    }

    function Field(props) {
      return h('div', { style: { marginTop: props.first ? 0 : 10 } }, [
        props.label ? h('div', { key: 'label', style: LABEL }, props.label) : null,
        props.children,
        props.help ? h('div', { key: 'help', style: MUTED }, props.help) : null,
      ])
    }

    function Text(props) {
      return h('input', {
        style: INPUT,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        type: props.type || 'text',
        onChange: (event) => props.onChange(event.target.value),
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          style: INPUT,
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          onChange: (event) => props.onChange(event.target.value),
        },
        props.options.map(([value, label]) => h('option', { key: value, value }, label)),
      )
    }

    function Check(props) {
      return h(
        'label',
        {
          style: {
            display: 'flex',
            gap: 9,
            alignItems: 'flex-start',
            padding: '6px 0',
            fontSize: 13,
            cursor: 'pointer',
          },
        },
        [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: Boolean(props.checked),
            onChange: (event) => props.onChange(event.target.checked),
            style: { marginTop: 2 },
          }),
          h('span', { key: 'text' }, [
            h('span', { key: 'label' }, props.label),
            props.help ? h('div', { key: 'help', style: MUTED }, props.help) : null,
          ]),
        ],
      )
    }

    function stateLabel(value) {
      return { running: '运行中', stopped: '已停止', error: '出错', disabled: '已关闭' }[value] || value || '未知'
    }

    function warpLabel(value) {
      return {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '未连接',
        unknown: '状态未知',
      }[value] || value || '状态未知'
    }

    function clock(value) {
      if (!value) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    function duration(seconds) {
      const total = Math.max(0, Math.trunc(Number(seconds) || 0))
      if (total < 60) return `${total} 秒`
      if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
      const hours = Math.floor(total / 3600)
      return `${hours} 小时 ${Math.floor((total % 3600) / 60)} 分`
    }

    function bytes(value) {
      const n = Number(value) || 0
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${n} B`
    }

    function auditLine(entry) {
      if (!entry || typeof entry !== 'object') return String(entry)
      const bits = []
      if (entry.at) bits.push(clock(entry.at))
      if (entry.kind) bits.push(String(entry.kind))
      if (entry.ip) bits.push(String(entry.ip))
      if (entry.command) bits.push(String(entry.command).replace(/\s+/g, ' ').slice(0, 120))
      if (entry.ok !== undefined) bits.push(entry.ok ? 'ok' : '失败')
      if (entry.exitCode !== undefined && entry.exitCode !== null) bits.push(`退出码 ${entry.exitCode}`)
      if (entry.ms !== undefined) bits.push(`${entry.ms}ms`)
      if (entry.url) bits.push(String(entry.url))
      if (entry.error) bits.push(String(entry.error))
      if (bits.length === 0) return JSON.stringify(entry)
      return bits.join(' · ')
    }

    function SettingsPage() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState({})
      const [mode, setMode] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [loadError, setLoadError] = useState('')
      const [note, setNote] = useState('')
      const [devices, setDevices] = useState(null)
      const [test, setTest] = useState(null)
      const [pairCode, setPairCode] = useState(null)
      const [pairNow, setPairNow] = useState(() => Date.now())
      const [pairUrl, setPairUrl] = useState('')
      const [pairInput, setPairInput] = useState('')

      const load = useCallback(async () => {
        try {
          const next = await api('state')
          setData(next)
          setLoadError('')
        } catch (err) {
          setLoadError(String(err?.message || err))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 5000)
        return () => clearInterval(timer)
      }, [load])

      useEffect(() => {
        if (!pairCode) return undefined
        const timer = setInterval(() => setPairNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [pairCode])

      const config = data?.config || {}
      const status = data?.status || {}
      const addresses = Array.isArray(status.addresses) ? status.addresses : []
      const registered = Array.isArray(status.tools?.registered) ? status.tools.registered : []
      const dirty = Object.keys(draft)
      const value = (key) => (draft[key] !== undefined ? draft[key] : config[key])
      const set = (key, next) => setDraft((current) => ({ ...current, [key]: next }))
      const listenPort = Number(status.listen?.port || config.listenPort || 0)
      const defaultSecretPath = config.settingsPath
        ? String(config.settingsPath).replace(/settings\.json$/i, 'secret')
        : '$DSH_HOME/pc-bridge/secret'
      const peer = status.peer || {}
      const paired = Boolean(String(value('peerUrl') || '').trim())
      const pairedName = value('peerName') || peer.name || '—'
      const pairedPlatform = value('peerPlatform') || peer.platform || '—'
      const pairedTransport = value('peerTransport') || peer.transport || '—'
      const pairedUrl = value('peerUrl') || peer.url || ''
      const pairedAt = value('peerPairedAt') || peer.pairedAt || ''

      const derivedMode = String(value('remoteMode') || '') === 'tailscale'
        ? 'remote'
        : String(value('listenHost') || '') === '0.0.0.0'
          ? 'lan'
          : 'local'
      const currentMode = mode || derivedMode

      const tailscale = addresses.find((item) => String(item?.iface || '').toLowerCase().includes('tailscale'))
      const tailscaleUrl = tailscale ? `http://${tailscale.address}:${listenPort}` : ''

      const pairDeadline = pairCode
        ? Number.isFinite(Number(pairCode.expiresAt))
          ? Number(pairCode.expiresAt)
          : Date.parse(String(pairCode.expiresAt)) || 0
        : 0
      const pairRemaining = pairCode
        ? Math.max(0, Math.ceil((pairDeadline - pairNow) / 1000))
        : 0

      async function run(label, fn) {
        setBusy(label)
        setError('')
        setNote('')
        try {
          await fn()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      function pickMode(next) {
        setMode(next)
        if (next === 'local') {
          set('listenHost', '127.0.0.1')
          set('remoteMode', 'off')
        } else if (next === 'lan') {
          set('listenHost', '0.0.0.0')
          set('remoteMode', 'off')
        } else if (next === 'remote') {
          set('remoteMode', 'tailscale')
          if (String(value('listenHost') || '') === '127.0.0.1') set('listenHost', '0.0.0.0')
        }
      }

      async function copy(text) {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
          } else {
            throw new Error('no clipboard api')
          }
          setNote(`已复制：${text}`)
        } catch {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
            setNote(`已复制：${text}`)
          } catch {
            setNote(`复制失败，请手动复制：${text}`)
          }
        }
      }

      async function save() {
        const NUMERIC = [
          'listenPort',
          'discoveryPort',
          'pairTtlSec',
          'auditKeep',
          'defaultTimeoutMs',
          'maxTimeoutMs',
          'maxOutputBytes',
        ]
        await run('save', async () => {
          const patch = {}
          for (const key of Object.keys(draft)) {
            let next = draft[key]
            if (typeof next === 'string') next = next.trim()
            if (NUMERIC.includes(key)) {
              if (next === '') continue
              next = Number(next)
              if (!Number.isFinite(next)) throw new Error(`${key} 必须是数字`)
            }
            patch[key] = next
          }
          if (Object.keys(patch).length === 0) {
            setNote('没有要保存的改动。')
            return
          }
          const next = await post('config', { patch })
          const warnings = Array.isArray(next.warnings) ? next.warnings.map(String) : []
          setData((current) => ({
            ...(current || {}),
            status: next.status || current?.status,
            config: next.config || current?.config,
          }))
          setDraft({})
          setMode(null)
          setNote(
            warnings.length
              ? `已保存，但有警告：${warnings.join('；')}`
              : '已保存并应用；执行桥已重启（只重启插件内的监听，不重启 DSH）。',
          )
        })
      }

      async function toggleEnabled(next) {
        if (busy) return
        await run('enabled', async () => {
          const updated = await post('enabled', { enabled: next })
          setData((current) => ({
            ...(current || {}),
            status: updated.status || current?.status,
            config: updated.config || current?.config,
          }))
          setNote(next ? '已开启，执行桥开始监听。' : '已关闭，执行桥停止监听。')
        })
      }

      async function warpAction(action) {
        await run(`warp-${action}`, async () => {
          const next = await post('warp', { action })
          setData((current) => ({
            ...(current || {}),
            status: next.status || current?.status,
          }))
          if (action === 'dns-only') {
            setNote('WARP 已切到「仅 DNS」模式：DNS 保护还在，不再和 Tailscale 抢路由。')
          } else if (action === 'tunnel') {
            setNote('WARP 已恢复隧道模式；如果 Tailscale 掉线，把远程连接切回本机或局域网。')
          } else {
            setNote('已刷新 WARP 状态。')
          }
        })
      }

      async function testPeer() {
        await run('test', async () => {
          const next = await post('test', { url: value('peerUrl') || '' })
          setTest(next.result)
          setNote(next.result?.ok ? '连接成功，对端在线。' : '连接失败，请看下方结果。')
        })
      }

      async function rotateSecret() {
        if (!window.confirm('重置本机口令？其他电脑需要用新口令重新配对，已有的对端会连不上。')) return
        await run('rotate', async () => {
          const next = await post('secret/rotate')
          setData((current) => ({ ...(current || {}), status: next.status }))
          setNote('口令已重置，执行桥已重启。')
        })
      }

      async function clearPair() {
        await run('pair-clear', async () => {
          const next = await post('pair/clear')
          setData((current) => ({
            ...(current || {}),
            status: next.status || current?.status,
            config: next.config || current?.config,
          }))
          setDraft((current) => {
            const copy = { ...current }
            for (const key of ['peerUrl', 'peerName', 'peerPlatform', 'peerTransport', 'peerPairedAt', 'peerFingerprint']) {
              delete copy[key]
            }
            return copy
          })
          setPairUrl('')
          setNote('已断开配对，本机不再连接对端。')
        })
      }

      async function cleanupData() {
        if (!window.confirm('确定删除本机全部数据？将删除密钥、settings.json、审计日志和执行桥日志，且无法恢复。')) return
        await run('cleanup', async () => {
          const next = await post('cleanup', { confirm: true })
          const removed = Array.isArray(next.removed) ? next.removed : []
          const failed = Array.isArray(next.failed) ? next.failed : []
          setDraft({})
          setMode(null)
          setTest(null)
          await load()
          setNote(
            failed.length
              ? `已删除 ${removed.length} 个文件；${failed.length} 个删除失败：${failed.join('；')}`
              : `已删除本机数据（${removed.length} 个文件）。`,
          )
        })
      }

      async function discover() {
        await run('discover', async () => {
          const next = await api('discover')
          const found = Array.isArray(next.devices) ? next.devices : []
          setDevices(found)
          setNote(found.length ? `找到 ${found.length} 台设备。` : '没有找到设备：确认对端已开启发现，并在同一网段。')
        })
      }

      function useDevice(device) {
        const host = device.host || device.address
        const url = `http://${host}:${device.port || 18790}`
        set('peerUrl', url)
        setMode('custom')
        setPairUrl(url)
        setNote(`已把对端地址填成 ${url}，记得点「保存并应用」。`)
      }

      async function newPairCode() {
        await run('pair-new', async () => {
          const next = await post('pair/new')
          setPairCode({ code: next.code, expiresAt: next.expiresAt })
          setPairNow(Date.now())
          setNote('配对码已生成，5 分钟内有效，只能用一次。')
        })
      }

      async function acceptPair() {
        const url = pairUrl.trim() || String(value('peerUrl') || '').trim()
        if (!url) {
          setError('先把对端地址填上（可以直接点上面设备列表的「使用」）。')
          return
        }
        if (!pairInput.trim()) {
          setError('请输入对端显示的 6 位配对码。')
          return
        }
        await run('pair-accept', async () => {
          const next = await post('pair/accept', { url, code: pairInput.trim() })
          setData((current) => ({ ...(current || {}), status: next.status }))
          setDraft((current) => {
            const copy = { ...current }
            delete copy.peerUrl
            return copy
          })
          setPairInput('')
          setNote(`配对成功：${next.peer?.host || url}。已写入对端口令并重启。`)
        })
      }

      if (!data) {
        return h(
          'div',
          { style: { padding: 20 } },
          loadError ? `读取执行桥状态失败：${loadError}` : '读取执行桥状态…',
        )
      }

      const enabledCard = h(Card, { key: 'enabled', title: '开关' }, [
        h(Check, {
          key: 'enabled',
          checked: status.enabled !== false,
          label: '启用电脑执行桥',
          help: '关闭后立即停止监听、不注册工具；设置保留。',
          onChange: (next) => void toggleEnabled(next),
        }),
        h('div', { key: 'state', style: { ...MUTED, marginTop: 4 } }, `当前运行状态：${stateLabel(status.state)}。开关立即生效；其他改动点底部「保存并应用」。`),
      ])

      const statusCard = h(Card, { key: 'status', title: '状态' }, [
        h('div', { key: 'rows' }, [
          h('div', { key: 'state', style: ROW }, [
            h('span', { key: 'k' }, '运行状态'),
            h('b', { key: 'v', style: { color: status.state === 'running' ? '#16a34a' : status.state === 'error' ? '#ef4444' : status.state === 'disabled' ? '#f59e0b' : undefined } }, stateLabel(status.state)),
          ]),
          h('div', { key: 'listen', style: ROW }, [
            h('span', { key: 'k' }, '监听地址'),
            h('span', { key: 'v' }, status.listen ? `http://${status.listen.host}:${status.listen.port}` : '未监听'),
          ]),
          h('div', { key: 'uptime', style: ROW }, [
            h('span', { key: 'k' }, '已运行'),
            h('span', { key: 'v' }, status.state === 'running' ? duration(status.uptimeSec) : '—'),
          ]),
          h('div', { key: 'tools', style: ROW }, [
            h('span', { key: 'k' }, '工具'),
            h('span', { key: 'v' }, registered.length ? registered.join(' / ') : '未注册（省 token）'),
          ]),
          h('div', { key: 'secret', style: ROW }, [
            h('span', { key: 'k' }, '密钥'),
            h('span', { key: 'v' }, `${status.secret?.source || '未知'}${status.secret?.fingerprint ? ` · ${status.secret.fingerprint}` : ''}`),
          ]),
          h('div', { key: 'tailscale', style: ROW }, [
            h('span', { key: 'k' }, 'Tailscale 地址'),
            h('span', { key: 'v' }, tailscale
              ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, [
                  h('span', { key: 'u' }, tailscaleUrl),
                  h('button', { key: 'c', style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 }, onClick: () => void copy(tailscaleUrl) }, '复制'),
                ])
              : '未发现（Tailscale 未安装或未登录）'),
          ]),
          h('div', { key: 'tunnel', style: ROW }, [
            h('span', { key: 'k' }, 'SSH 隧道'),
            h('span', { key: 'v' }, status.tunnel?.enabled ? (status.tunnel.running ? '已开启 · 已连接' : '已开启 · 未连上') : '关闭'),
          ]),
          h('div', { key: 'discovery', style: ROW }, [
            h('span', { key: 'k' }, '设备发现'),
            h('span', { key: 'v' }, status.discovery?.enabled ? `UDP ${status.discovery.port} · ${status.discovery.running ? '运行中' : '未运行'}` : '关闭'),
          ]),
          h('div', { key: 'peerstate', style: ROW }, [
            h('span', { key: 'k' }, '对端连接'),
            h('span', { key: 'v' }, status.connected === true ? '在线' : status.connected === false ? '离线' : '—'),
          ]),
          h('div', { key: 'error', style: ROW }, [
            h('span', { key: 'k' }, '最近错误'),
            h('span', { key: 'v', style: { color: status.lastError ? '#ef4444' : undefined, textAlign: 'right' } }, status.lastError || '无'),
          ]),
        ]),
        h('div', { key: 'shell', style: { ...MUTED, marginTop: 8 } }, [
          `本机 ${status.shell?.kind || '未知 shell'} · ${status.shell?.exe || '未解析'} · 版本 ${data.version || '?'} · ${clock(status.startedAt)} 启动`,
        ]),
      ])

      const addressCard = h(Card, { key: 'addresses', title: '地址' }, [
        h('div', { key: 'list' }, [
          h('div', { key: 'loop', style: { ...ROW, alignItems: 'center' } }, [
            h('span', { key: 'k' }, '本机回环'),
            h('span', { key: 'v', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, [
              h('span', { key: 'u' }, `http://${status.listen?.host || '127.0.0.1'}:${listenPort || '—'}`),
              h('button', {
                key: 'c',
                style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 },
                disabled: !listenPort,
                onClick: () => void copy(`http://${status.listen?.host || '127.0.0.1'}:${listenPort}`),
              }, '复制'),
            ]),
          ]),
          ...addresses.map((item, index) => h('div', { key: `addr-${index}`, style: { ...ROW, alignItems: 'center' } }, [
            h('span', { key: 'k' }, `${item.iface || '网卡'} · ${item.family || 'IPv4'}`),
            h('span', { key: 'v', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, [
              h('span', { key: 'u' }, item.address),
              h('button', {
                key: 'c',
                style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 },
                onClick: () => void copy(`http://${item.address}:${listenPort}`),
              }, '复制'),
            ]),
          ])),
          addresses.length === 0 ? h('div', { key: 'none', style: MUTED }, '没有非回环 IPv4 地址。') : null,
        ]),
      ])

      const tailscaleInfo = status.tailscale || {}
      const warpInfo = status.warp || {}
      const remoteInfo = status.remote || {}
      const remoteUrlLive = String(remoteInfo.url || '').trim()

      const networkCard = h(Card, { key: 'network', title: '远程连接（Tailscale）与 WARP' }, [
        h('div', { key: 'ts', style: ROW }, [
          h('span', { key: 'k' }, 'Tailscale'),
          h('span', { key: 'v', style: { textAlign: 'right' } }, tailscaleInfo.installed
            ? `${tailscaleInfo.online ? '在线' : '离线'}${tailscaleInfo.ipv4 ? ` · ${tailscaleInfo.ipv4}` : ''}${tailscaleInfo.peers ? ` · ${tailscaleInfo.peers} 台设备` : ''}`
            : '未安装或未登录'),
        ]),
        tailscaleInfo.dnsName
          ? h('div', { key: 'dns', style: ROW }, [
              h('span', { key: 'k' }, 'Tailscale 域名'),
              h('span', { key: 'v', style: { wordBreak: 'break-all', textAlign: 'right' } }, tailscaleInfo.dnsName),
            ])
          : null,
        h('div', { key: 'remote', style: ROW }, [
          h('span', { key: 'k' }, '远程地址'),
          h('span', { key: 'v', style: { display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, remoteUrlLive
            ? [
                h('span', { key: 'u' }, remoteUrlLive),
                h('button', {
                  key: 'c',
                  style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 },
                  onClick: () => void copy(remoteUrlLive),
                }, '复制'),
              ]
            : '—'),
        ]),
        h('div', { key: 'warp', style: ROW }, [
          h('span', { key: 'k' }, 'WARP'),
          h('span', { key: 'v', style: { textAlign: 'right' } }, warpInfo.installed
            ? `${warpLabel(warpInfo.state)} · ${warpInfo.mode || '未知模式'}${warpInfo.tunnel ? '（隧道）' : ''}`
            : (warpInfo.supported === false ? '未安装' : '未检测')),
        ]),
        h('div', { key: 'buttons', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, [
          h('button', {
            key: 'dns',
            style: BUTTON,
            disabled: Boolean(busy) || !warpInfo.installed,
            onClick: () => void warpAction('dns-only'),
          }, busy === 'warp-dns-only' ? '切换中…' : 'WARP 只做 DNS（共存）'),
          h('button', {
            key: 'tunnel',
            style: BUTTON,
            disabled: Boolean(busy) || !warpInfo.installed,
            onClick: () => void warpAction('tunnel'),
          }, busy === 'warp-tunnel' ? '恢复中…' : '恢复 WARP 隧道'),
          h('button', { key: 'refresh', style: BUTTON, disabled: Boolean(busy), onClick: () => void warpAction('status') }, '刷新网络状态'),
        ]),
        h(Check, {
          key: 'coexist',
          checked: value('warpCoexist') !== false,
          label: '远程模式启动时自动让 WARP 只做 DNS',
          help: '勾选后，只要连接方式选「远程（Tailscale）」，执行桥启动时会检查 WARP；发现它开着隧道就切到「仅 DNS」，让 Tailscale 保持在线。不勾就完全不动 WARP。',
          onChange: (next) => set('warpCoexist', next),
        }),
        remoteInfo.mode !== 'tailscale'
          ? h('div', { key: 'hint', style: { ...MUTED, marginTop: 6 } }, '要异地直连，请把下面的「连接方式」切到「远程（Tailscale）」并保存。')
          : h('div', { key: 'hint', style: { ...MUTED, marginTop: 6 } }, '平板/手机打开上面的远程地址即可访问；打不开的话，在 Windows 防火墙放行该端口（只对 Tailscale 接口开放更安全）。'),
      ])

      const modeCard = h(Card, { key: 'mode', title: '连接方式' }, [
        h(Choice, {
          key: 'local',
          name: 'pc-bridge-mode',
          value: 'local',
          checked: currentMode === 'local',
          label: '本机',
          desc: '只监听 127.0.0.1，只有本机的 DSH 能连（最安全，默认）。',
          onChange: pickMode,
        }),
        h(Choice, {
          key: 'lan',
          name: 'pc-bridge-mode',
          value: 'lan',
          checked: currentMode === 'lan',
          label: '局域网',
          desc: '监听 0.0.0.0，同一网段的其他设备可以连；需要在防火墙放行端口。',
          onChange: pickMode,
        }),
        h(Choice, {
          key: 'remote',
          name: 'pc-bridge-mode',
          value: 'remote',
          checked: currentMode === 'remote',
          label: '远程（Tailscale）',
          desc: '不在同一个 Wi-Fi 也能连：监听所有网卡，本页会显示 tailnet 地址；两端登录同一个 tailnet 即可。开启后工具也会注册。',
          onChange: pickMode,
        }),
        h(Choice, {
          name: 'pc-bridge-mode',
          value: 'custom',
          checked: currentMode === 'custom',
          label: '自定义',
          desc: '填对端地址 peerUrl，本机主动去连对端（也可以同时保留监听）。',
          onChange: pickMode,
        }),
        currentMode === 'custom'
          ? h(Field, {
              key: 'peer',
              label: '对端地址（peerUrl）',
              help: '例如 http://192.168.1.20:18790，留空表示不连对端。',
            }, h(Text, {
              value: value('peerUrl'),
              placeholder: 'http://192.168.1.20:18790',
              onChange: (next) => set('peerUrl', next),
            }))
          : null,
        h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '切换只改草稿里的监听地址，不会清空已配对的对端；点「保存并应用」才生效。'),
      ])

      const discoverCard = h(Card, { key: 'discover', title: '附近的电脑' }, [
        h('div', { key: 'row', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } }, [
          h('button', { key: 'scan', style: BUTTON, disabled: Boolean(busy), onClick: () => void discover() }, busy === 'discover' ? '搜索中…' : '搜索附近设备'),
          h('span', { key: 'tip', style: MUTED }, '向局域网广播一次，1.2 秒内回应的电脑会列出来。'),
        ]),
        devices
          ? h('div', { key: 'list', style: { marginTop: 8 } }, devices.length === 0
              ? [h('div', { key: 'none', style: MUTED }, '没有找到设备。确认对端 DSH 已启动、发现服务已开启，并且在同一网段。')]
              : devices.map((device, index) => h('div', { key: `dev-${index}`, style: { ...ROW, alignItems: 'center' } }, [
                  h('span', { key: 'name' }, [
                    h('b', { key: 'n' }, device.name || '未命名设备'),
                    h('span', { key: 'd', style: { ...MUTED, marginLeft: 8 } }, `${device.host || device.address}:${device.port || 18790} · ${device.platform || '?'}${device.version ? ` · v${device.version}` : ''}`),
                  ]),
                  h('button', {
                    key: 'use',
                    style: { ...BUTTON, padding: '3px 10px', fontSize: 12 },
                    onClick: () => useDevice(device),
                  }, '使用'),
                ])))
          : null,
      ])

      const pairCard = h(Card, { key: 'pair', title: '配对' }, [
        paired
          ? h('div', {
              key: 'paired',
              style: {
                padding: '10px 12px',
                marginBottom: 12,
                borderRadius: 8,
                background: 'rgba(34,197,94,.10)',
              },
            }, [
              h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 6 } }, [
                h('b', { key: 'title', style: { fontSize: 13 } }, '已配对'),
                h('button', {
                  key: 'clear',
                  style: { ...BUTTON, padding: '3px 10px', fontSize: 12, borderColor: '#ef4444', color: '#ef4444' },
                  disabled: Boolean(busy),
                  onClick: () => void clearPair(),
                }, busy === 'pair-clear' ? '断开中…' : '断开配对'),
              ]),
              h('div', { key: 'rows' }, [
                h('div', { key: 'name', style: ROW }, [
                  h('span', { key: 'k' }, '对端名称'),
                  h('span', { key: 'v' }, pairedName),
                ]),
                h('div', { key: 'platform', style: ROW }, [
                  h('span', { key: 'k' }, '平台'),
                  h('span', { key: 'v' }, pairedPlatform),
                ]),
                h('div', { key: 'transport', style: ROW }, [
                  h('span', { key: 'k' }, '传输方式'),
                  h('span', { key: 'v' }, pairedTransport),
                ]),
                h('div', { key: 'url', style: ROW }, [
                  h('span', { key: 'k' }, '对端地址'),
                  h('span', { key: 'v', style: { wordBreak: 'break-all', textAlign: 'right' } }, pairedUrl),
                ]),
                h('div', { key: 'at', style: ROW }, [
                  h('span', { key: 'k' }, '配对时间'),
                  h('span', { key: 'v' }, pairedAt ? clock(pairedAt) : '—'),
                ]),
              ]),
            ])
          : null,
        h('div', { key: 'nrow', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } }, [
          h('button', { key: 'new', style: BUTTON, disabled: Boolean(busy), onClick: () => void newPairCode() }, busy === 'pair-new' ? '生成中…' : '生成配对码'),
          pairCode
            ? h('span', { key: 'code', style: { fontSize: 22, fontWeight: 700, letterSpacing: 6, fontVariantNumeric: 'tabular-nums' } }, pairCode.code)
            : null,
          pairCode
            ? h('span', { key: 'left', style: MUTED }, pairRemaining > 0 ? `剩余 ${pairRemaining} 秒` : '已过期，请重新生成')
            : null,
        ]),
        h('div', { key: 'hint', style: { ...MUTED, marginTop: 6 } }, `把码念给另一台电脑的主人，或在另一台电脑的同一个页面里输入。一台电脑生成，另一台填写。${Number(status.pairingsCount) > 0 ? ` 本机记录过 ${status.pairingsCount} 台配对设备。` : ''}`),
        h('div', { key: 'accept', style: { marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--dsh-border, rgba(127,127,127,.25))' } }, [
          h('div', { key: 'title', style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '配对到对端'),
          h('div', { key: 'grid', style: GRID }, [
            h(Field, { key: 'url', first: true, label: '对端地址' }, h(Text, {
              value: pairUrl,
              placeholder: 'http://192.168.1.20:18790',
              onChange: setPairUrl,
            })),
            h(Field, { key: 'code', label: '配对码' }, h(Text, {
              value: pairInput,
              placeholder: '6 位数字',
              onChange: setPairInput,
            })),
          ]),
          h('div', { key: 'actions', style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('button', { key: 'go', style: PRIMARY, disabled: Boolean(busy), onClick: () => void acceptPair() }, busy === 'pair-accept' ? '配对中…' : '开始配对'),
            h('span', { key: 'tip', style: MUTED }, '对端地址留空时用上面的 peerUrl。'),
          ]),
        ]),
      ])

      const toolsMode = String(value('toolsMode') || 'auto')
      const toolsCard = h(Card, { key: 'tools', title: '工具' }, [
        toolsMode === 'off'
          ? h('div', { key: 'legacy', style: { ...MUTED, marginBottom: 6 } }, '当前是旧值 off（不注册工具）；勾选或取消勾选即可切回 always / auto。')
          : null,
        h(Check, {
          key: 'always',
          checked: toolsMode === 'always',
          label: '没配对端时也注册 pc_ping / pc_exec',
          help: '不勾（默认）：只有填了对端地址或开了远程模式才注册，平时不占工具位、省 token。勾上：无论有没有对端都注册。要完全关掉工具？用上面的总开关。',
          onChange: (next) => set('toolsMode', next ? 'always' : 'auto'),
        }),
      ])

      const advancedCard = h(Card, { key: 'advanced', title: '高级参数' }, [
        h('div', { key: 'grid', style: GRID }, [
          h(Field, { key: 'listenPort', first: true, label: '监听端口', help: '0 = 随机端口；默认 18790。' }, h(Text, {
            value: value('listenPort'),
            type: 'number',
            onChange: (next) => set('listenPort', next),
          })),
          h(Field, { key: 'discoveryPort', label: '发现端口（UDP）' }, h(Text, {
            value: value('discoveryPort'),
            type: 'number',
            onChange: (next) => set('discoveryPort', next),
          })),
          h(Field, { key: 'defaultTimeoutMs', label: '默认超时（毫秒）' }, h(Text, {
            value: value('defaultTimeoutMs'),
            type: 'number',
            onChange: (next) => set('defaultTimeoutMs', next),
          })),
          h(Field, { key: 'maxOutputBytes', label: '最大输出（字节）', help: `约 ${bytes(value('maxOutputBytes'))}` }, h(Text, {
            value: value('maxOutputBytes'),
            type: 'number',
            onChange: (next) => set('maxOutputBytes', next),
          })),
          h(Field, { key: 'pairTtlSec', label: '配对码有效期（秒）' }, h(Text, {
            value: value('pairTtlSec'),
            type: 'number',
            onChange: (next) => set('pairTtlSec', next),
          })),
          h(Field, { key: 'auditKeep', label: '审计日志保留份数' }, h(Text, {
            value: value('auditKeep'),
            type: 'number',
            onChange: (next) => set('auditKeep', next),
          })),
        ]),
        h(Field, {
          key: 'secretFile',
          label: '密钥文件路径（secretFile）',
          help: `留空使用默认路径 ${defaultSecretPath}；改路径会迁移：写新文件 → 校验 → 删除旧文件（旧文件删不掉只警告）。密钥来自配置或环境变量时不能迁移。保存后执行桥会自动重启一次（毫秒级），不用重启软件。`,
        }, h(Text, {
          value: value('secretFile'),
          placeholder: defaultSecretPath,
          onChange: (next) => set('secretFile', next),
        })),
        h(Field, { key: 'shell', label: 'shell（只读）' }, h('div', {
          style: { ...MUTED, padding: '6px 0', wordBreak: 'break-all' },
        }, `${status.shell?.kind || '未知'} · ${status.shell?.exe || ''}`)),
        h('label', { key: 'discovery', style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13, cursor: 'pointer' } }, [
          h('input', {
            type: 'checkbox',
            checked: value('discoveryEnabled') !== false,
            onChange: (event) => set('discoveryEnabled', event.target.checked),
          }),
          h('span', { key: 'text' }, '允许其他电脑通过 UDP 发现本机（关了就只能手动填地址配对）'),
        ]),
        h(Check, {
          key: 'purge',
          checked: value('purgeOnUninstall') === true,
          label: '移除插件时尝试自动删除本机数据（实验性，默认关）',
          help: '只有确认 profile 已不再依赖本插件时才会执行；不确定就保持关闭。',
          onChange: (next) => set('purgeOnUninstall', next),
        }),
        h('div', {
          key: 'cleanup',
          style: {
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px dashed var(--dsh-border, rgba(127,127,127,.25))',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          },
        }, [
          h('button', {
            key: 'go',
            style: { ...BUTTON, borderColor: '#ef4444', color: '#ef4444' },
            disabled: Boolean(busy),
            onClick: () => void cleanupData(),
          }, busy === 'cleanup' ? '删除中…' : '删除本机数据'),
          h('span', { key: 'tip', style: MUTED }, '删除密钥、settings.json、审计日志和执行桥日志，不可恢复。'),
        ]),
        h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '改完点最下面的「保存并应用」。听 0.0.0.0 时记得在系统防火墙放行端口。'),
      ])

      const audit = Array.isArray(data.audit) ? data.audit : []
      const auditCard = h(Card, { key: 'audit', title: '审计日志（最近 20 条）' }, [
        audit.length
          ? h('pre', {
              key: 'pre',
              style: {
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: 11.5,
                maxHeight: 260,
                overflow: 'auto',
                background: 'rgba(127,127,127,.08)',
                padding: 10,
                borderRadius: 8,
              },
            }, audit.map((entry) => auditLine(entry)).join('\n'))
          : h('div', { key: 'none', style: MUTED }, '还没有记录。执行命令、启停、改配置和配对都会写在这里。'),
      ])

      const footer = h('div', { key: 'footer', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } }, [
        h('button', { key: 'save', style: PRIMARY, disabled: Boolean(busy), onClick: () => void save() }, busy === 'save' ? '保存中…' : '保存并应用'),
        h('button', { key: 'test', style: BUTTON, disabled: Boolean(busy), onClick: () => void testPeer() }, busy === 'test' ? '测试中…' : '测试连接'),
        h('button', { key: 'rotate', style: BUTTON, disabled: Boolean(busy), onClick: () => void rotateSecret() }, busy === 'rotate' ? '重置中…' : '重置口令'),
        h('span', { key: 'hint', style: MUTED }, dirty.length === 0 ? '配置已保存' : `${dirty.length} 项改动未保存`),
      ])

      const testCard = test
        ? h(Card, { key: 'testout', title: '连接测试结果' }, [
            h('div', { key: 'head', style: { fontSize: 13, marginBottom: 6, color: test.ok ? '#16a34a' : '#ef4444' } }, test.ok ? '对端在线' : `失败：${test.error || test.reason || '未知原因'}`),
            h('pre', {
              key: 'pre',
              style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5, background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 8 },
            }, JSON.stringify(test, null, 2)),
          ])
        : null

      return h('div', { style: { maxWidth: 880, margin: '0 auto', padding: '4px 0 24px' } }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 } }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 18 } }, '电脑执行桥'),
          h('span', { key: 'ver', style: MUTED }, `v${data.version || '?'} · ${status.role || 'both'} · ${stateLabel(status.state)}`),
        ]),

        error
          ? h('div', { key: 'err', style: { padding: '9px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(239,68,68,.12)', color: '#ef4444', fontSize: 13 } }, error)
          : null,
        !error && loadError
          ? h('div', { key: 'loaderr', style: { padding: '9px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(239,68,68,.12)', color: '#ef4444', fontSize: 13 } }, `状态刷新失败：${loadError}`)
          : null,
        note
          ? h('div', { key: 'note', style: { padding: '9px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(34,197,94,.12)', color: '#16a34a', fontSize: 13 } }, note)
          : null,

        enabledCard,
        statusCard,
        addressCard,
        networkCard,
        modeCard,
        discoverCard,
        pairCard,
        toolsCard,
        advancedCard,
        auditCard,
        testCard,
        footer,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'pc-bridge', order: 18, label: () => '电脑执行桥' },
            SettingsPage,
          ),
        )
      },
    }
  },
})
