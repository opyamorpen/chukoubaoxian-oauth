/**
 * 插件运行时配置读取。
 * 配置声明在 config/plugin.yaml 的 service.config,
 * 管理员可在 ONES 插件详情页(插件未启用时)修改,
 * 后端通过 Plugin.getPluginConfig 读取。
 */
import { Plugin } from '@ones-op/node-ability'
import { env } from '@ones-op/sdk/backend'
import { Logger } from '@ones-op/node-logger'

export interface SinosureSettings {
  ssoBaseUrl: string
  clientId: string
  clientSecret: string
  oaBaseUrl: string
  eosSourceSysKey: string
  eosApiSubscriptionKey: string
  emailSuffix: string
  rootDeptName: string
  company: string
  excludeEmployeeTypes: string[]
}

const FALLBACK: SinosureSettings = {
  ssoBaseUrl: '',
  clientId: '',
  clientSecret: '',
  oaBaseUrl: '',
  eosSourceSysKey: '',
  eosApiSubscriptionKey: '',
  emailSuffix: '@sinosure.cn',
  rootDeptName: '中国出口信用保险公司',
  company: '中国信保',
  excludeEmployeeTypes: [],
}

/** getPluginConfig 可能返回 {key: value} 或 [{arg_key, arg_value}] 两种形态 */
function normalizePluginConfig(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = (item ?? {}) as Record<string, unknown>
      const key = typeof record.arg_key === 'string' ? record.arg_key : typeof record.key === 'string' ? record.key : ''
      if (key) {
        result[key] = record.arg_value != null ? String(record.arg_value) : record.value != null ? String(record.value) : ''
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = String(value)
      }
    }
  }
  return result
}

export async function loadSettings(): Promise<SinosureSettings> {
  let config: Record<string, string> = {}
  try {
    const teamUUID = await env.getTeamID()
    config = normalizePluginConfig(await Plugin.getPluginConfig(teamUUID))
  } catch (error) {
    Logger.warning('[sinosure] 读取插件配置失败,使用默认值:', error)
  }

  const settings: SinosureSettings = {
    ssoBaseUrl: (config.ssoBaseUrl ?? FALLBACK.ssoBaseUrl).trim().replace(/\/+$/, ''),
    clientId: (config.clientId ?? FALLBACK.clientId).trim(),
    clientSecret: config.clientSecret ?? FALLBACK.clientSecret,
    oaBaseUrl: (config.oaBaseUrl ?? FALLBACK.oaBaseUrl).trim().replace(/\/+$/, ''),
    eosSourceSysKey: config.eosSourceSysKey ?? FALLBACK.eosSourceSysKey,
    eosApiSubscriptionKey: config.eosApiSubscriptionKey ?? FALLBACK.eosApiSubscriptionKey,
    emailSuffix: (config.emailSuffix ?? FALLBACK.emailSuffix).trim() || FALLBACK.emailSuffix,
    rootDeptName: (config.rootDeptName ?? FALLBACK.rootDeptName).trim() || FALLBACK.rootDeptName,
    company: (config.company ?? FALLBACK.company).trim(),
    excludeEmployeeTypes: (config.excludeEmployeeTypes ?? '')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean),
  }

  const missing: string[] = []
  if (!settings.ssoBaseUrl) missing.push('单点登录服务地址(ssoBaseUrl)')
  if (!settings.clientId) missing.push('client_id')
  if (!settings.clientSecret) missing.push('client_secret')
  if (!settings.oaBaseUrl) missing.push('OA 平台地址(oaBaseUrl)')
  if (!settings.eosSourceSysKey) missing.push('X-EOS-SourceSysKey')
  if (!settings.eosApiSubscriptionKey) missing.push('X-EOS-ApiSubScriptionKey')
  if (missing.length > 0) {
    throw new Error(`插件配置不完整,请在插件详情页填写: ${missing.join('、')}`)
  }
  return settings
}
