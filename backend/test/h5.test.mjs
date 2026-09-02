import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { decryptToken, parsePayload, validateH5Token } from '../src/lib/h5Token.ts'

const KEY = '0123456789abcdef0123456789abcdef' // 32 hex = 16 bytes
const IV = 'fedcba9876543210fedcba9876543210' // 32 hex = 16 bytes

function encrypt(plaintext, { algorithm = 'aes-128-cbc', key = KEY, iv = IV } = {}) {
  const keyBuf = Buffer.from(key, 'hex')
  const cipher = algorithm.endsWith('ecb')
    ? createCipheriv(algorithm, keyBuf, null)
    : createCipheriv(algorithm, keyBuf, Buffer.from(iv, 'hex'))
  return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]).toString('base64')
}

test('decryptToken: AES-128-CBC hex 密钥 + IV', () => {
  const token = encrypt(JSON.stringify({ userid: 'weish', timestamp: 1759000000, systemCode: 'ONES' }))
  const plaintext = decryptToken(token, { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV })
  assert.equal(plaintext, JSON.stringify({ userid: 'weish', timestamp: 1759000000, systemCode: 'ONES' }))
})

test('decryptToken: AES-256-ECB 无 IV', () => {
  const key256 = KEY + KEY // 64 hex = 32 bytes
  const token = encrypt('userid=abc&ts=1759000000', { algorithm: 'aes-256-ecb', key: key256 })
  const plaintext = decryptToken(token, { algorithm: 'aes-256-ecb', secretKey: key256, iv: '' })
  assert.equal(plaintext, 'userid=abc&ts=1759000000')
})

test('decryptToken: 密钥错误返回 null', () => {
  const token = encrypt('hello')
  assert.equal(decryptToken(token, { algorithm: 'aes-128-cbc', secretKey: 'ffffffffffffffffffffffffffffffff', iv: IV }), null)
})

test('parsePayload: JSON 与 URL 参数两种载体,秒/毫秒时间戳', () => {
  assert.deepEqual(parsePayload('{"userid":"weish","timestamp":1759000000,"systemCode":"ONES"}'), {
    userid: 'weish',
    timestamp: 1759000000,
    systemCode: 'ONES',
  })
  assert.deepEqual(parsePayload('userid=abc&ts=1759000000123'), {
    userid: 'abc',
    timestamp: 1759000000123,
    systemCode: undefined,
  })
  assert.equal(parsePayload('{"name":"no userid"}'), null)
})

test('validateH5Token: 有效秒级时间戳 + 系统编码一致', () => {
  const now = Date.now()
  const token = encrypt(JSON.stringify({ userid: 'weish', timestamp: Math.floor(now / 1000), systemCode: 'ONES' }))
  const check = validateH5Token(
    token,
    { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV, systemCode: 'ONES', tokenTtlMinutes: 10 },
    now,
  )
  assert.equal(check.ok, true)
  assert.equal(check.userid, 'weish')
})

test('validateH5Token: 过期拒绝', () => {
  const now = Date.now()
  const token = encrypt(JSON.stringify({ userid: 'weish', timestamp: Math.floor((now - 11 * 60 * 1000) / 1000) }))
  const check = validateH5Token(
    token,
    { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV, systemCode: '', tokenTtlMinutes: 10 },
    now,
  )
  assert.equal(check.ok, false)
  assert.ok(check.reason?.includes('有效期'))
})

test('validateH5Token: 系统编码不匹配拒绝 / 未携带系统编码放行', () => {
  const now = Date.now()
  const ts = Math.floor(now / 1000)
  const mismatch = encrypt(JSON.stringify({ userid: 'weish', timestamp: ts, systemCode: 'OTHER' }))
  assert.equal(
    validateH5Token(mismatch, { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV, systemCode: 'ONES', tokenTtlMinutes: 10 }, now).ok,
    false,
  )
  const noCode = encrypt(JSON.stringify({ userid: 'weish', timestamp: ts }))
  assert.equal(
    validateH5Token(noCode, { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV, systemCode: 'ONES', tokenTtlMinutes: 10 }, now).ok,
    true,
  )
})

test('validateH5Token: 缺 token / 无法解密 / 缺 userid / 缺时间戳', () => {
  const cfg = { algorithm: 'aes-128-cbc', secretKey: KEY, iv: IV, systemCode: '', tokenTtlMinutes: 10 }
  assert.equal(validateH5Token('', cfg).ok, false)
  assert.equal(validateH5Token('not-base64-###', cfg).ok, false)
  const noUser = encrypt(JSON.stringify({ timestamp: 1759000000 }))
  assert.equal(validateH5Token(noUser, cfg).ok, false)
  const noTs = encrypt(JSON.stringify({ userid: 'weish' }))
  const check = validateH5Token(noTs, cfg)
  assert.equal(check.ok, false)
  assert.ok(check.reason?.includes('时间戳'))
})
