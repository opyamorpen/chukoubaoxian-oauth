/**
 * APP H5 登录:一次性 code 签发/消费(实体存储)。
 * token 校验纯函数在 h5Token.ts,此处 re-export 供调用方统一引用。
 */
import { randomBytes } from 'crypto'
import { storage } from '@ones-op/sdk/backend'

export * from './h5Token'

const H5_CODE_TTL_SECONDS = 120
const H5_CODE_ENTITY = 'h5_code'

/** 签发 120 秒一次性登录 code,H5 页面携带其重定向回 ONES 第三方登录回调 */
export async function issueH5Code(userid: string): Promise<string> {
  const code = randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + H5_CODE_TTL_SECONDS * 1000).toISOString()
  await storage.entity(H5_CODE_ENTITY).set(code, { userid, expires_at: expiresAt })
  return code
}

/** 消费一次性 code:过期或不存在返回 null;成功即删除(单次使用) */
export async function consumeH5Code(code: string): Promise<string | null> {
  const entity = storage.entity(H5_CODE_ENTITY)
  const record = (await entity.get(code)) as { userid?: string; expires_at?: string } | undefined
  if (!record?.userid) {
    return null
  }
  await entity.delete(code)
  const expiresAt = Date.parse(record.expires_at ?? '')
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    return null
  }
  return record.userid
}
