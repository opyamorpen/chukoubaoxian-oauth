/**
 * 客户单点系统(基于 CAS 的 OAuth2.0)客户端。
 * 接口依据《OAuth2.0介绍与对接文档》:
 *   授权   GET  {base}/cas/oauth2.0/authorize
 *   换token POST {base}/cas/oauth2.0/accessToken
 *   用户信息 GET {base}/cas/oauth2.0/profile
 *   登出   GET  {base}/cas/oauth2.0/logout
 */
import { Fetch } from '@ones-op/fetch'

export interface SsoCredentials {
  ssoBaseUrl: string
  clientId: string
  clientSecret: string
}

export interface SsoToken {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** 响应可能是 JSON 字符串、JSON 对象或 CAS 表单格式,统一解析为对象 */
function parseBody(data: unknown): Record<string, any> {
  if (data && typeof data === 'object') {
    return data as Record<string, any>
  }
  if (typeof data === 'string') {
    const text = data.trim()
    try {
      return JSON.parse(text)
    } catch {
      // 兜底:access_token=xxx&refresh_token=yyy 形式
      const params = new URLSearchParams(text)
      const result: Record<string, any> = {}
      params.forEach((value, key) => {
        result[key] = value
      })
      return result
    }
  }
  return {}
}

export function buildAuthorizeUrl(credentials: SsoCredentials, redirectUri: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
  })
  return `${joinUrl(credentials.ssoBaseUrl, '/cas/oauth2.0/authorize')}?${query.toString()}`
}

export function buildLogoutUrl(ssoBaseUrl: string, serviceUrl: string): string {
  const query = new URLSearchParams({ service: serviceUrl })
  return `${joinUrl(ssoBaseUrl, '/cas/oauth2.0/logout')}?${query.toString()}`
}

/** 授权码换 access_token。redirect_uri 必须与授权请求一致,单点系统会校验。 */
export async function exchangeTokenByCode(
  credentials: SsoCredentials,
  code: string,
  redirectUri: string,
): Promise<SsoToken> {
  const response = await Fetch(joinUrl(credentials.ssoBaseUrl, '/cas/oauth2.0/accessToken'), {
    method: 'POST',
    params: {
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    },
  })
  const body = parseBody(response?.data)
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (!accessToken) {
    throw new Error(`换取 access_token 失败: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : undefined,
  }
}

/** 用 access_token 获取用户信息。attributes 中文为 URL 编码,由 transform 层解码。 */
export async function fetchProfile(ssoBaseUrl: string, accessToken: string): Promise<Record<string, any>> {
  const response = await Fetch(joinUrl(ssoBaseUrl, '/cas/oauth2.0/profile'), {
    method: 'GET',
    params: { access_token: accessToken },
  })
  return parseBody(response?.data)
}
