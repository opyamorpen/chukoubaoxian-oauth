/**
 * ONES account 能力(对接三方系统)v1.0.0 实现。
 * 四个能力函数与客户系统的对接:
 * - CreateLoginUrl:返回统一认证平台授权地址(登录入口由 ONES 依据本能力自动渲染)
 * - DoExchangeUser:code 换 token -> 拉用户信息 -> 返回 userid;
 *   H5 一次性 code 优先:命中则直接返回对应身份(网页 OAuth2 与 APP H5 复用同一交换通道)
 * - DoPullData:OA 人员+部门 -> 部门树/用户列表,ONES 每 10 分钟自动调度
 * - SendMessage:未启用消息推送(canMessage=false),保留桩实现
 */
import { Logger } from '@ones-op/node-logger'
import type { PluginRequest, PluginResponse } from '@ones-op/node-types'
import { requireConfig, validateConfig } from './lib/config'
import { getLastRedirectUri, saveLastRedirectUri } from './lib/ssoState'
import { buildAuthorizeUrl, exchangeTokenByCode, fetchProfile } from './lib/ssoClient'
import { consumeH5Code } from './lib/h5'
import { fabricateEmail, normalizeProfile } from './lib/transform'
import { runSync } from './lib/syncEngine'

// ---------- account 能力响应结构(与官方模板一致) ----------

interface CreateLoginUrlResponse {
  url: string
}

function CreateLoginUrlRespData(
  code: number,
  errcode: unknown,
  model: unknown,
  reason: unknown,
  type: unknown,
  body: CreateLoginUrlResponse,
): PluginResponse {
  return { body: { code, errcode, model, reason, type, body } }
}

interface DoExchangeUserResponse {
  third_party_id: string
  name: string
  title: string
  avatar: string
  email: string
  phone: string
}

function DoExchangeUserRespData(
  code: number,
  errcode: unknown,
  model: unknown,
  reason: unknown,
  type: unknown,
  body: DoExchangeUserResponse,
): PluginResponse {
  return { body: { code, errcode, model, reason, type, body } }
}

function DoPullDataRespData(
  code: number,
  errcode: unknown,
  model: unknown,
  reason: unknown,
  type: unknown,
  body: { departments: unknown[]; users: unknown[] },
): PluginResponse {
  return { body: { code, errcode, model, reason, type, body } }
}

function sendMessageRespData(
  code: number,
  errcode: unknown,
  model: unknown,
  reason: unknown,
  type: unknown,
): PluginResponse {
  return { body: { code, errcode, model, reason, type } }
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseAuthCode(request: PluginRequest | undefined): string {
  const body = request?.body as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ''
  }
  try {
    const authInfo = typeof body.auth_info === 'string' ? JSON.parse(body.auth_info) : body.auth_info
    return String((authInfo as Record<string, unknown>)?.code ?? '')
  } catch {
    return ''
  }
}

// ---------- 能力函数 ----------

export async function CreateLoginUrl(request: PluginRequest): Promise<PluginResponse> {
  const empty: CreateLoginUrlResponse = { url: '' }
  try {
    const config = await requireConfig()
    const validation = validateConfig(config)
    if (!validation.oauthReady) {
      return CreateLoginUrlRespData(500, '', '', 'OAuth 2.0 配置不完整,统一身份登录暂不可用', '', empty)
    }

    const requestRedirect = (request?.body as Record<string, unknown> | undefined)?.redirect_url
    // 配置的回调地址优先;留空时使用 ONES 传入的 redirect_url
    const redirectUri =
      config.oauth.redirectUri || (typeof requestRedirect === 'string' ? requestRedirect : '')
    if (!redirectUri) {
      return CreateLoginUrlRespData(500, '', '', '缺少回调地址(请在配置页填写或由 ONES 登录流程传入)', '', empty)
    }

    await saveLastRedirectUri(redirectUri)
    const url = buildAuthorizeUrl(config.oauth, redirectUri)
    Logger.info('[sinosure] CreateLoginUrl ->', url)
    return CreateLoginUrlRespData(200, '200', '', '', '', { url })
  } catch (error) {
    return CreateLoginUrlRespData(500, '', '', failureReason(error), '', empty)
  }
}

export async function DoExchangeUser(request: PluginRequest): Promise<PluginResponse> {
  const empty: DoExchangeUserResponse = {
    third_party_id: '',
    name: '',
    title: '',
    avatar: '',
    email: '',
    phone: '',
  }
  try {
    const code = parseAuthCode(request)
    if (!code) {
      return DoExchangeUserRespData(500, '', '', 'auth_info 中缺少授权码 code', '', empty)
    }

    const config = await requireConfig()

    // H5 一次性 code 优先(APP H5 登录复用同一身份交换通道)
    const h5Userid = await consumeH5Code(code)
    if (h5Userid) {
      Logger.info('[sinosure] DoExchangeUser via H5 code, userid =', h5Userid)
      return DoExchangeUserRespData(200, '', '', '', '', {
        third_party_id: h5Userid,
        name: h5Userid,
        title: '',
        avatar: '',
        email: fabricateEmail(h5Userid, config.account.emailSuffix),
        phone: '',
      })
    }

    // 网页端 OAuth 2.0:code 换 token -> 拉用户信息
    const validation = validateConfig(config)
    if (!validation.oauthReady) {
      return DoExchangeUserRespData(500, '', '', 'OAuth 2.0 配置不完整,统一身份登录暂不可用', '', empty)
    }
    const redirectUri = await getLastRedirectUri()
    const token = await exchangeTokenByCode(config.oauth, code, redirectUri)
    const profile = await fetchProfile(config.oauth.profileUrl, token.accessToken)

    const normalized = normalizeProfile(profile)
    if (!normalized.ok) {
      return DoExchangeUserRespData(500, '', '', normalized.reason, '', empty)
    }

    Logger.info('[sinosure] DoExchangeUser ok, third_party_id =', normalized.userId)
    return DoExchangeUserRespData(200, '', '', '', '', {
      third_party_id: normalized.userId,
      name: normalized.name,
      title: '',
      avatar: '',
      // 统一认证不返回邮箱;与目录同步时的拼接规则保持一致,便于按邮箱绑定的场景兜底
      email: fabricateEmail(normalized.userId, config.account.emailSuffix),
      phone: '',
    })
  } catch (error) {
    return DoExchangeUserRespData(500, '', '', failureReason(error), '', empty)
  }
}

export async function DoPullData(_request: PluginRequest): Promise<PluginResponse> {
  const empty = { departments: [], users: [] }
  try {
    const config = await requireConfig()
    const validation = validateConfig(config)
    if (!validation.oaReady) {
      return DoPullDataRespData(500, '', '', 'OA 通讯录配置不完整,本次同步不执行', '', empty)
    }

    const report = await runSync(config, 'auto', true)
    if (!report.ok) {
      return DoPullDataRespData(500, '', '', report.error ?? '同步失败', '', empty)
    }
    return DoPullDataRespData(200, '', '', '', '', {
      departments: report.departments ?? [],
      users: report.users ?? [],
    })
  } catch (error) {
    return DoPullDataRespData(500, '', '', failureReason(error), '', empty)
  }
}

export async function SendMessage(request: PluginRequest): Promise<PluginResponse> {
  Logger.info('[sinosure] SendMessage 请求(canMessage=false,仅记录):', request?.body)
  return sendMessageRespData(200, '', '', '', '')
}
