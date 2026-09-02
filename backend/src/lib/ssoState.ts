/**
 * 单点登录流程状态:最近一次授权请求使用的回调地址。
 * 换 token 时回调地址必须与授权请求一致,认证平台会校验。
 */
import { storage } from '@ones-op/sdk/backend'
import { Logger } from '@ones-op/node-logger'

const KEY = 'last_redirect_uri'
const ENTITY = 'sso_state'

export async function saveLastRedirectUri(redirectUri: string): Promise<void> {
  try {
    await storage.entity(ENTITY).set(KEY, {
      value: redirectUri,
      updated_at: new Date().toISOString(),
    })
  } catch (error) {
    Logger.warning('[sinosure] 保存回调地址失败(将使用空值兜底):', error)
  }
}

export async function getLastRedirectUri(): Promise<string> {
  try {
    const record = (await storage.entity(ENTITY).get(KEY)) as { value?: string } | undefined
    return typeof record?.value === 'string' ? record.value : ''
  } catch (error) {
    Logger.warning('[sinosure] 读取回调地址失败:', error)
    return ''
  }
}
