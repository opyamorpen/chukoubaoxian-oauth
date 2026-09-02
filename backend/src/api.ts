/**
 * 插件 API(供配置页与 H5 入口页调用,均注册为 addition 类型)。
 * 密钥字段:读取脱敏、保存可"留空保持不变"、日志不输出明文。
 */
import { Logger } from '@ones-op/node-logger'
import { Fetch } from '@ones-op/fetch'
import type { PluginRequest, PluginResponse } from '@ones-op/node-types'
import {
  loadConfig,
  maskConfig,
  mergeSecrets,
  normalizeConfig,
  saveConfig,
  validateConfig,
} from './lib/config'
import { fetchOaDepartments, fetchOaEmployees } from './lib/oaClient'
import { buildAuthorizeUrl } from './lib/ssoClient'
import { getLastRedirectUri } from './lib/ssoState'
import { issueH5Code, validateH5Token } from './lib/h5'
import { acquireSyncLock, readLatestAudit, releaseSyncLock, runSync } from './lib/syncEngine'

function ok(body: Record<string, unknown>): PluginResponse {
  return { body: { ok: true, ...body } }
}

function fail(reason: string, extra: Record<string, unknown> = {}): PluginResponse {
  return { body: { ok: false, reason, ...extra } }
}

function requestBody(request: PluginRequest | undefined): Record<string, any> {
  const body = request?.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, any>
  }
  return {}
}

// ---------- 配置 ----------

export async function apiConfigGet(_request: PluginRequest): Promise<PluginResponse> {
  const config = await loadConfig()
  if (!config) {
    return ok({ config: maskConfig(normalizeConfig(null)), configured: false, validation: validateConfig(normalizeConfig(null)) })
  }
  return ok({ config: maskConfig(config), configured: true, validation: validateConfig(config) })
}

export async function apiConfigSave(request: PluginRequest): Promise<PluginResponse> {
  const body = requestBody(request)
  const existing = await loadConfig()
  // 密钥留空 = 保持不变
  const merged = mergeSecrets(normalizeConfig(body.config), existing)
  const validation = validateConfig(merged)
  if (!validation.ok) {
    // 校验失败拒绝保存,保留上一份有效配置
    return fail('配置校验失败', { errors: validation.errors })
  }
  await saveConfig(merged)
  Logger.info('[sinosure] 配置已更新(oauthReady=%s, oaReady=%s, h5Ready=%s)', validation.oauthReady, validation.oaReady, validation.h5Ready)
  return ok({ config: maskConfig(merged), validation })
}

/** 连通性测试:target=oa 拉两个接口计数;target=oauth 构造授权地址并探测可达性 */
export async function apiConfigTest(request: PluginRequest): Promise<PluginResponse> {
  const body = requestBody(request)
  const config = await loadConfig()
  if (!config) {
    return fail('插件尚未保存配置')
  }
  const target = String(body.target ?? '')

  if (target === 'oa') {
    const validation = validateConfig(config)
    if (!validation.oaReady) {
      return fail('OA 通讯录配置不完整,无法测试')
    }
    try {
      const [employees, departments] = await Promise.all([
        fetchOaEmployees(config.oa),
        fetchOaDepartments(config.oa),
      ])
      return ok({ detail: `连接成功:人员 ${employees.length} 条,部门 ${departments.length} 条` })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  if (target === 'oauth') {
    const validation = validateConfig(config)
    if (!validation.oauthReady) {
      return fail('OAuth 2.0 配置不完整,无法测试')
    }
    const probeUrl = buildAuthorizeUrl(config.oauth, config.oauth.redirectUri || 'https://ones.example.com/callback')
    try {
      await Fetch(probeUrl, { method: 'GET', timeout: 10000 })
      return ok({ detail: '授权地址可达(认证平台已响应)' })
    } catch (error) {
      return fail(`授权地址不可达: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return fail('未知的测试目标')
}

// ---------- 同步 ----------

/** 手动同步:与自动同步同口径(拉取+校验+状态维护+审计);锁定中不重复启动 */
export async function apiSyncManual(_request: PluginRequest): Promise<PluginResponse> {
  const config = await loadConfig()
  if (!config) {
    return fail('插件尚未配置,无法同步')
  }
  const validation = validateConfig(config)
  if (!validation.oaReady) {
    return fail('OA 通讯录配置不完整,本次同步不执行')
  }

  const locked = await acquireSyncLock()
  if (!locked) {
    return fail('同步任务正在执行中,请稍后再试', { busy: true })
  }
  try {
    const report = await runSync(config, 'manual', false)
    if (!report.ok) {
      return fail(report.error ?? '同步失败', {
        deptCount: report.deptCount,
        userCount: report.userCount,
      })
    }
    return ok({
      deptCount: report.deptCount,
      userCount: report.userCount,
      skippedCount: report.skippedCount,
      preservedDeptCount: report.preservedDeptCount,
      warnings: report.warnings.slice(0, 50),
    })
  } finally {
    await releaseSyncLock()
  }
}

export async function apiSyncStatus(_request: PluginRequest): Promise<PluginResponse> {
  const latest = await readLatestAudit()
  const config = await loadConfig()
  const validation = config ? validateConfig(config) : validateConfig(normalizeConfig(null))
  return ok({
    latest,
    autoIntervalMinutes: 10,
    oauthReady: validation.oauthReady,
    oaReady: validation.oaReady,
    h5Ready: validation.h5Ready,
  })
}

// ---------- APP H5 登录 ----------

/**
 * H5 入口页调用:本地校验 token ->(可选)服务端二次校验 -> 签发一次性 code。
 * 页面随后携带 code 重定向到 ONES 第三方登录回调,由 DoExchangeUser 完成身份交换。
 */
export async function apiH5Verify(request: PluginRequest): Promise<PluginResponse> {
  const body = requestBody(request)
  const token = String(body.token ?? '')
  if (!token) {
    return fail('缺少 token')
  }
  const config = await loadConfig()
  if (!config) {
    return fail('插件尚未配置')
  }
  if (!config.h5.enabled) {
    return fail('APP H5 登录未启用')
  }
  const validation = validateConfig(config)
  if (!validation.h5Ready) {
    return fail('APP H5 登录配置不完整')
  }

  const check = validateH5Token(token, config.h5)
  if (!check.ok) {
    return fail(check.reason ?? 'token 校验失败')
  }

  // 可选服务端二次校验
  if (config.h5.verifyUrl) {
    try {
      const response = await Fetch(config.h5.verifyUrl, {
        method: 'POST',
        data: { token },
        timeout: 10000,
      })
      if (response?.status && (response.status < 200 || response.status >= 300)) {
        return fail(`token 服务端校验失败(HTTP ${response.status})`)
      }
    } catch (error) {
      return fail(`token 服务端校验请求失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const code = await issueH5Code(check.userid)
  const redirect = config.oauth.redirectUri || (await getLastRedirectUri())
  if (!redirect) {
    return fail('ONES 回调地址未知,请先完成一次网页端统一身份登录或在配置页填写回调地址')
  }
  const target = new URL(redirect)
  target.searchParams.set('code', code)
  Logger.info('[sinosure] H5 token 校验通过,已签发一次性 code')
  return ok({ userid: check.userid, redirect: target.toString() })
}
