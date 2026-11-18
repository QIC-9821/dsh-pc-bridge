import { createHash, randomBytes } from 'node:crypto'

import {
  callExec,
  callFileList,
  callFileRead,
  callFileWrite,
  callPing,
  pullFile,
  pushFile,
} from './client.mjs'

const INLINE_READ_MAX = 131072
const INLINE_READ_DEFAULT = 16384
const INLINE_WRITE_MAX = 1048576

function textRender(_args, value) {
  return [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }]
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: textRender,
}

/**
 * A per-call peer lets one side reach several bridges: the default peerUrl is
 * a fixed address, while a tablet's LAN address can change with the network.
 * Only absolute http(s) URLs are accepted, so a typo cannot turn into a
 * relative request against the local host.
 */
export function resolvePeer(peer, fallback) {
  const text = String(peer || '').trim()
  if (!text) return { ok: true, url: fallback }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: `peer is not a valid URL: ${text}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `peer must be http or https: ${text}` }
  }
  return { ok: true, url: url.toString().replace(/\/+$/, '') }
}

export function pcToolSpecs({
  baseUrl,
  secret,
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
} = {}) {
  return [
    {
      name: 'pc_ping',
      description: [
        'Ping a dsh-pc-bridge peer: this machine\'s configured peer by default, or any bridge via `peer`.',
        'Returns host, user, shell kind and time, or a network error with the URL it tried.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
        },
        additionalProperties: false,
      },
      timeoutMs: 15000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        return callPing(target.url, secret)
      },
    },
    {
      name: 'pc_exec',
      description: [
        'Run a shell command through a dsh-pc-bridge peer and return stdout/stderr/exitCode.',
        'Windows uses Git Bash, POSIX /bin/bash, Android sh; `peer` targets another bridge. Default timeout 30s.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on the peer.' },
          timeoutSec: { type: 'number', description: 'Optional timeout in seconds (clamped by the bridge config).' },
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      timeoutMs: 660000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        return callExec(
          target.url,
          secret,
          { command: args?.command, timeoutSec: args?.timeoutSec },
          { defaultTimeoutMs, maxTimeoutMs },
        )
      },
    },
  ]
}

function inlineOffset(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function inlineReadBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return INLINE_READ_DEFAULT
  return Math.min(Math.trunc(number), INLINE_READ_MAX)
}

/**
 * Auto encoding only claims "text" when the decoded string round-trips back to
 * the identical bytes and carries no NUL: that keeps binary payloads (images,
 * archives, UTF-16) in base64 instead of returning mojibake.
 */
function decodeText(buffer) {
  if (buffer.includes(0)) return null
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null
}

export function pcFileToolSpecs({
  baseUrl,
  secret,
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
  chunkBytes = 1048576,
  maxBytes = 67108864,
} = {}) {
  return [
    {
      name: 'pc_file_list',
      description: 'List a directory on a dsh-pc-bridge peer: entry name, type, size and mtime.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path on the peer.' },
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
          limit: { type: 'number', description: 'Optional maximum number of entries.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      timeoutMs: 600000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        return callFileList(target.url, secret, {
          path: args?.path,
          limit: args?.limit,
        })
      },
    },
    {
      name: 'pc_file_read',
      description: 'Read a file on a dsh-pc-bridge peer as utf8/base64 (paged), or download it via `dest`.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path on the peer.' },
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
          offset: { type: 'number', description: 'Byte offset to start reading (default 0).' },
          maxBytes: { type: 'number', description: 'Max inline bytes (default 16384, capped at 131072).' },
          encoding: {
            type: 'string',
            enum: ['auto', 'utf8', 'base64'],
            description: 'Inline content encoding; auto detects UTF-8 text.',
          },
          dest: { type: 'string', description: 'Local path to download the whole file to instead of returning content.' },
          overwrite: { type: 'boolean', description: 'Allow overwriting an existing local dest.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      timeoutMs: 600000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        const remotePath = String(args?.path || '').trim()
        if (!remotePath) return { ok: false, error: 'path is empty' }

        const dest = String(args?.dest || '').trim()
        if (dest) {
          return pullFile(target.url, secret, {
            path: remotePath,
            dest,
            overwrite: Boolean(args?.overwrite),
            chunkBytes,
            maxBytes,
          })
        }

        const offset = inlineOffset(args?.offset)
        const response = await callFileRead(target.url, secret, {
          path: remotePath,
          offset,
          maxBytes: inlineReadBytes(args?.maxBytes),
        })
        if (!response.ok) return response

        const buffer = Buffer.from(String(response.data || ''), 'base64')
        const requested = args?.encoding === 'utf8' || args?.encoding === 'base64'
          ? args.encoding
          : 'auto'
        let encoding = requested
        let content
        if (requested === 'auto') {
          const text = decodeText(buffer)
          if (text === null) {
            encoding = 'base64'
            content = buffer.toString('base64')
          } else {
            encoding = 'utf8'
            content = text
          }
        } else if (requested === 'utf8') {
          content = buffer.toString('utf8')
        } else {
          content = buffer.toString('base64')
        }

        const start = Number.isFinite(Number(response.offset)) ? Number(response.offset) : offset
        return {
          ok: true,
          path: response.path ?? remotePath,
          size: response.size,
          offset: start,
          bytes: buffer.length,
          eof: Boolean(response.eof),
          encoding,
          content,
          truncated: !response.eof,
          nextOffset: start + buffer.length,
        }
      },
    },
    {
      name: 'pc_file_write',
      description: 'Write a file on a dsh-pc-bridge peer from inline content (up to 1 MiB) or upload a local file via `source`.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path on the peer.' },
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
          content: { type: 'string', description: 'Inline content to write.' },
          source: { type: 'string', description: 'Local file path to upload instead of inline content.' },
          encoding: {
            type: 'string',
            enum: ['utf8', 'base64'],
            description: 'Encoding of inline content (default utf8).',
          },
          append: { type: 'boolean', description: 'Append instead of replacing the remote file.' },
          createDirs: { type: 'boolean', description: 'Create missing parent directories on the peer.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      timeoutMs: 600000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        const remotePath = String(args?.path || '').trim()
        if (!remotePath) return { ok: false, error: 'path is empty' }

        const source = String(args?.source || '').trim()
        if (source) {
          return pushFile(target.url, secret, {
            path: remotePath,
            source,
            chunkBytes,
            maxBytes,
          })
        }

        if (args?.content === undefined || args?.content === null) {
          return { ok: false, error: 'content 与 source 至少给一个' }
        }

        const data = args?.encoding === 'base64'
          ? Buffer.from(String(args.content), 'base64')
          : Buffer.from(String(args.content), 'utf8')
        if (data.length > INLINE_WRITE_MAX) {
          return { ok: false, error: '内联内容过大，请改用 source' }
        }

        const chunkSha256 = createHash('sha256').update(data).digest('hex')
        const response = await callFileWrite(target.url, secret, {
          path: remotePath,
          uploadId: randomBytes(8).toString('hex'),
          offset: 0,
          data: data.toString('base64'),
          final: true,
          append: Boolean(args?.append),
          createDirs: Boolean(args?.createDirs),
          chunkSha256,
          expectedSha256: chunkSha256,
        })
        if (!response.ok) return { ok: false, error: response.error || 'file/write failed' }
        return {
          ok: true,
          path: response.path ?? remotePath,
          size: response.size,
          sha256: response.sha256,
        }
      },
    },
  ]
}
