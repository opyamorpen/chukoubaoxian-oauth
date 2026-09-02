/**
 * ONES account 能力(对接三方系统)v1.0.0 实现。
 * 四个能力函数与客户两个系统的对接关系:
 * - CreateLoginUrl:返回单点系统 OAuth2 授权地址(登录入口由 ONES 依据本能力自动渲染)
 * - DoExchangeUser:code 换 token -> 拉 profile -> 返回用户标识,ONES 按 third_party_id 匹配已同步账号
 * - DoPullData:拉 OA 人员+部门接口 -> 组装根部门(-1)/部门/处室树与用户列表,ONES 每 10 分钟调度
 * - SendMessage:未启用消息推送(canMessage=false),保留桩实现
 */
import { Logger } from '@ones-op/node-logger'
import { storage } from '@ones-op/sdk/backend'
import type { PluginRequest, PluginResponse } from '@ones-op/node-types'
import { loadSettings } from './lib/settings'
import { buildAuthorizeUrl, exchangeTokenByCode, fetchProfile } from './lib/ssoClient'
import { fetchOaDepartments, fetchOaEmployees } from './lib/oaClient'
import {
  buildDepartments,
  buildUsers,
  fabricateEmail,
  normalizeProfile,
  type DepartmentInfo,
  type UserInfo,
} from './lib/transform'

const LAST_REDIRECT_URI_KEY = 'last_redirect_uri'
const AUDIT_LATEST_KEY = 'latest'

async function saveLastRedirectUri(redirectUri: string): Promise<void> {
  try {
    await storage.entity('sso_state').set(LAST_REDIRECT_URI_KEY, {
      value: redirectUri,
      updated_at: new Date().toISOString(),
    })
  } catch (error) {
    Logger.warning('[sinosure] 保存 redirect_uri 失败(将使用空值兜底):', error)
  }
}

async function getLastRedirectUri(): Promise<string> {
  try {
    const record = (await storage.entity('sso_state').get(LAST_REDIRECT_URI_KEY)) as
      | Record<string, unknown>
      | undefined
    return typeof record?.value === 'string' ? record.value : ''
  } catch (error) {
    Logger.warning('[sinosure] 读取 redirect_uri 失败:', error)
    return ''
  }
}

async function writeSyncAudit(record: {
  deptCount: number
  userCount: number
  skippedCount: number
  error: string
}): Promise<void> {
  const pulledAt = new Date().toISOString()
  const attributes = {
    pulled_at: pulledAt,
    dept_count: record.deptCount,
    user_count: record.userCount,
    skipped_count: record.skippedCount,
    error: record.error,
  }
  try {
    await storage.entity('sync_audit').set(AUDIT_LATEST_KEY, attributes)
    await storage.entity('sync_audit').set(pulledAt, attributes)
  } catch (error) {
    Logger.warning('[sinosure] 写入同步审计记录失败:', error)
  }
}

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
  return {
    body: {
      code,
      errcode,
      model,
      reason,
      type,
      body,
    },
  }
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
  return {
    body: {
      code,
      errcode,
      model,
      reason,
      type,
      body,
    },
  }
}

function DoPullDataRespData(
  code: number,
  errcode: unknown,
  model: unknown,
  reason: unknown,
  type: unknown,
  body: { departments: DepartmentInfo[]; users: UserInfo[] },
): PluginResponse {
  return {
    body: {
      code,
      errcode,
      model,
      reason,
      type,
      body,
    },
  }
}

function sendMessageRespData(code: number, errcode: unknown, model: unknown, reason: unknown, type: unknown): PluginResponse {
  return {
    body: {
      code,
      errcode,
      model,
      reason,
      type,
    },
  }
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------- 能力函数 ----------

export async function CreateLoginUrl(request: PluginRequest): Promise<PluginResponse> {
  const empty: CreateLoginUrlResponse = { url: '' }
  try {
    const redirectUrl = (request?.body as Record<string, unknown> | undefined)?.redirect_url
    if (typeof redirectUrl !== 'string' || !redirectUrl) {
      return CreateLoginUrlRespData(500, '', '', '缺少 redirect_url 参数', '', empty)
    }

    const settings = await loadSettings()
    // 单点系统换 token 时校验 redirect_uri 必须与授权请求一致,先落库供 DoExchangeUser 使用
    await saveLastRedirectUri(redirectUrl)
    const url = buildAuthorizeUrl(settings, redirectUrl)
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
    let code = ''
    const body = request?.body as Record<string, unknown> | undefined
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      try {
        const authInfo = typeof body.auth_info === 'string' ? JSON.parse(body.auth_info) : body.auth_info
        code = String((authInfo as Record<string, unknown>)?.code ?? '')
      } catch {
        code = ''
      }
    }
    if (!code) {
      return DoExchangeUserRespData(500, '', '', 'auth_info 中缺少授权码 code', '', empty)
    }

    const settings = await loadSettings()
    const redirectUri = await getLastRedirectUri()
    const token = await exchangeTokenByCode(settings, code, redirectUri)
    const profile = await fetchProfile(settings.ssoBaseUrl, token.accessToken)

    const normalized = normalizeProfile(profile)
    if (!normalized.ok) {
      return DoExchangeUserRespData(500, '', '', normalized.reason, '', empty)
    }

    const response: DoExchangeUserResponse = {
      third_party_id: normalized.userId,
      name: normalized.name,
      title: '',
      avatar: '',
      // profile 无邮箱字段;与目录同步时的拼接规则保持一致,便于按邮箱绑定的场景兜底
      email: fabricateEmail(normalized.userId, settings.emailSuffix),
      phone: '',
    }
    Logger.info('[sinosure] DoExchangeUser ok, third_party_id =', normalized.userId)
    return DoExchangeUserRespData(200, '', '', '', '', response)
  } catch (error) {
    return DoExchangeUserRespData(500, '', '', failureReason(error), '', empty)
  }
}

export async function DoPullData(_request: PluginRequest): Promise<PluginResponse> {
  const empty = { departments: [] as DepartmentInfo[], users: [] as UserInfo[] }
  try {
    const settings = await loadSettings()

    let employees: unknown[] = []
    let departments: unknown[] = []
    try {
      ;[employees, departments] = await Promise.all([
        fetchOaEmployees(settings),
        fetchOaDepartments(settings),
      ])
    } catch (error) {
      const message = failureReason(error)
      await writeSyncAudit({ deptCount: 0, userCount: 0, skippedCount: 0, error: message })
      return DoPullDataRespData(500, '', '', message, '', empty)
    }

    const departmentResult = buildDepartments(departments, settings.rootDeptName)
    const userResult = buildUsers(employees, {
      emailSuffix: settings.emailSuffix,
      excludeEmployeeTypes: settings.excludeEmployeeTypes,
      knownDeptIds: departmentResult.knownDeptIds,
      company: settings.company,
    })

    if (departmentResult.warnings.length > 0) {
      Logger.warning('[sinosure] 部门数据告警:', departmentResult.warnings.join('; '))
    }
    if (userResult.warnings.length > 0) {
      Logger.warning('[sinosure] 人员数据告警:', userResult.warnings.slice(0, 20).join('; '))
    }

    await writeSyncAudit({
      deptCount: departmentResult.departments.length,
      userCount: userResult.users.length,
      skippedCount: departmentResult.skipped.length + userResult.skipped.length,
      error: '',
    })
    Logger.info(
      `[sinosure] DoPullData: 部门 ${departmentResult.departments.length}(含根部门), 用户 ${userResult.users.length}, 跳过 ${departmentResult.skipped.length + userResult.skipped.length}`,
    )

    return DoPullDataRespData(200, '', '', '', '', {
      departments: departmentResult.departments,
      users: userResult.users,
    })
  } catch (error) {
    return DoPullDataRespData(500, '', '', failureReason(error), '', empty)
  }
}

export async function SendMessage(request: PluginRequest): Promise<PluginResponse> {
  Logger.info('[sinosure] SendMessage 请求(canMessage=false,仅记录):', request?.body)
  return sendMessageRespData(200, '', '', '', '')
}
