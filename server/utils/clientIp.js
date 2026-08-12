import net from 'net'
import { cfg } from '#guoba.platform'

function normalize(value) {
  if (typeof value !== 'string') return ''
  let ip = value.trim()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const version = net.isIP(ip)
  if (!version) return ''
  if (version === 6) {
    try {
      return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase()
    } catch {
      return ''
    }
  }
  return ip
}

function ipv4ToNumber(ip) {
  return ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
}

function inCidr(ip, cidr) {
  const [base, bitsText] = String(cidr).split('/')
  const normalized = normalize(base)
  if (!normalized || net.isIP(normalized) !== net.isIP(ip)) return false
  if (!bitsText) return normalized === ip
  const bits = Number(bitsText)
  const max = net.isIP(ip) === 4 ? 32 : 128
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return false
  if (net.isIP(ip) === 4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(normalized) & mask)
  }
  // IPv6 CIDR matching without a new dependency.
  const toBits = value => {
    const halves = value.split('::')
    let parts = halves[0].split(':').filter(Boolean)
    if (halves.length === 2) {
      const right = halves[1].split(':').filter(Boolean)
      parts = [...parts, ...Array(8 - parts.length - right.length).fill('0'), ...right]
    }
    if (parts.length !== 8) return ''
    return parts.map(part => Number.parseInt(part, 16).toString(2).padStart(16, '0')).join('')
  }
  const left = toBits(ip)
  const right = toBits(normalized)
  return !!left && left.slice(0, bits) === right.slice(0, bits)
}

function trustedPeer(peer) {
  const configured = cfg.get('server.trustedProxyCidrs')
  const list = Array.isArray(configured) ? configured : []
  return list.some(item => inCidr(peer, item))
}

export function getClientIp(req) {
  const peer = normalize(req?.socket?.remoteAddress || req?.connection?.remoteAddress)
  if (!peer) return ''
  if (!trustedPeer(peer)) return peer
  const forwarded = req?.headers?.['x-forwarded-for']
  const chain = typeof forwarded === 'string' ? forwarded.split(',').map(normalize).filter(Boolean) : []
  chain.push(peer)
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!trustedPeer(chain[i])) return chain[i]
  }
  return peer
}

export function normalizeClientIp(value) {
  return normalize(value)
}
