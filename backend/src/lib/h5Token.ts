/**
 * APP H5 token 校验的纯函数部分:解密、载荷解析、本地校验。
 * 不依赖任何 SDK,可独立做单元测试;一次性 code 的签发/消费见 h5.ts。
 *
 * token 规则由客户约定(方案 1.3 前置依赖),当前实现按以下通用框架:
 * - 密文:Base64;算法:AES-128/256 CBC/ECB(密钥 hex 或 utf8;CBC 需 iv)
 * - 明文:JSON 或 URL 参数,含 userid、时间戳(timestamp/ts,秒或毫秒)、可选系统编码
 * 客户规则到位后仅需调整 decryptToken/parsePayload 的参数映射。
 */
import { createDecipheriv } from 'crypto'
import type { H5Config } from './configSchema'

export interface H5TokenCheck {
  ok: boolean
  reason?: string
  userid: string
}

function decodeKey(secretKey: string, bytes: number): Buffer {
  if (/^[0-9a-fA-F]+$/.test(secretKey) && secretKey.length === bytes * 2) {
    return Buffer.from(secretKey, 'hex')
  }
  return Buffer.from(secretKey, 'utf8')
}

/** 解密 token;失败返回 null(具体原因由调用方给出) */
export function decryptToken(
  token: string,
  config: Pick<H5Config, 'algorithm' | 'secretKey' | 'iv'>,
): string | null {
  try {
    const algorithm = config.algorithm.toLowerCase()
    const keyBytes = algorithm.startsWith('aes-128') ? 16 : 32
    const key = decodeKey(config.secretKey, keyBytes)
    const ciphertext = Buffer.from(token, 'base64')

    let decipher
    if (algorithm.endsWith('ecb')) {
      decipher = createDecipheriv(algorithm, key, null)
    } else {
      const iv = config.iv ? decodeKey(config.iv, 16) : Buffer.alloc(16, 0)
      decipher = createDecipheriv(algorithm, key, iv)
    }
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    return null
  }
}

export interface H5TokenPayload {
  userid: string
  timestamp?: number
  systemCode?: string
}

/** 明文解析:兼容 JSON 与 URL 参数两种载体,时间戳兼容秒/毫秒 */
export function parsePayload(plaintext: string): H5TokenPayload | null {
  const text = plaintext.trim()
  let record: Record<string, unknown>
  try {
    record = JSON.parse(text)
  } catch {
    const params = new URLSearchParams(text)
    record = {}
    params.forEach((value, key) => {
      record[key] = value
    })
  }
  const userid = typeof record.userid === 'string' ? record.userid.trim() : ''
  if (!userid) {
    return null
  }
  const rawTimestamp = Number(record.timestamp ?? record.ts)
  const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : undefined
  const systemCode = typeof record.systemCode === 'string' ? record.systemCode.trim() : undefined
  return { userid, timestamp, systemCode }
}

/**
 * 本地校验(不含服务端二次校验):
 * 解密 -> 解析 -> userid -> 时间戳有效期 -> 系统编码。
 */
export function validateH5Token(
  token: string,
  config: Pick<H5Config, 'algorithm' | 'secretKey' | 'iv' | 'systemCode' | 'tokenTtlMinutes'>,
  now = Date.now(),
): H5TokenCheck {
  if (!token) {
    return { ok: false, reason: '缺少 token', userid: '' }
  }
  const plaintext = decryptToken(token, config)
  if (plaintext === null) {
    return { ok: false, reason: 'token 无法解密(算法或密钥不匹配)', userid: '' }
  }
  const payload = parsePayload(plaintext)
  if (payload === null) {
    return { ok: false, reason: 'token 内容格式错误(缺少 userid)', userid: '' }
  }
  if (payload.timestamp === undefined) {
    return { ok: false, reason: 'token 缺少时间戳', userid: payload.userid }
  }
  // 秒级时间戳转毫秒
  const issuedAt = payload.timestamp < 1e12 ? payload.timestamp * 1000 : payload.timestamp
  const ttlMs = config.tokenTtlMinutes * 60 * 1000
  if (now < issuedAt || now - issuedAt > ttlMs) {
    return { ok: false, reason: 'token 已超过约定有效期', userid: payload.userid }
  }
  if (config.systemCode && payload.systemCode && payload.systemCode !== config.systemCode) {
    return { ok: false, reason: 'token 系统编码不匹配', userid: payload.userid }
  }
  return { ok: true, userid: payload.userid }
}
