import crypto from 'crypto'

const PREFIX = 'scrypt'
const KEY_LENGTH = 64
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function validateUsername(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 64
}

export function validatePassword(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 128
}

export function hashPassword(password) {
  if (!validatePassword(password)) throw new Error('密码须为8至128位')
  const salt = crypto.randomBytes(16)
  const digest = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)
  return `${PREFIX}$${salt.toString('base64url')}$${digest.toString('base64url')}`
}

export function verifyPassword(password, encoded) {
  if (!validatePassword(password) || typeof encoded !== 'string') return false
  const parts = encoded.split('$')
  if (parts.length !== 3 || parts[0] !== PREFIX) return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    if (salt.length < 16 || expected.length !== KEY_LENGTH) return false
    const actual = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
