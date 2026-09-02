/**
 * 插件运行时配置:实体读写(plugin_config)。
 * 纯函数(结构/校验/脱敏/合并)在 configSchema.ts;本文件只负责持久化与读取。
 */
import { storage } from '@ones-op/sdk/backend'
import { Logger } from '@ones-op/node-logger'
import { normalizeConfig, type SinosureConfig } from './configSchema'

const CONFIG_KEY = 'active'
const CONFIG_ENTITY = 'plugin_config'

export * from './configSchema'

export async function saveConfig(config: SinosureConfig): Promise<void> {
  await storage.entity(CONFIG_ENTITY).set(CONFIG_KEY, {
    content: JSON.stringify(config),
    updated_at: new Date().toISOString(),
  })
}

export async function loadConfig(): Promise<SinosureConfig | null> {
  try {
    const record = (await storage.entity(CONFIG_ENTITY).get(CONFIG_KEY)) as
      | { content?: string }
      | undefined
    if (!record?.content) {
      return null
    }
    return normalizeConfig(JSON.parse(record.content))
  } catch (error) {
    Logger.warning('[sinosure] 读取插件配置失败:', error)
    return null
  }
}

/** 供能力函数使用:配置缺失时抛出可读错误 */
export async function requireConfig(): Promise<SinosureConfig> {
  const config = await loadConfig()
  if (!config) {
    throw new Error('插件尚未配置,请管理员在「统一身份与组织同步配置」页完成必填配置')
  }
  return config
}
