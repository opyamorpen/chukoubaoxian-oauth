/**
 * 客户统一认证平台(OAuth 2.0 授权码模式)客户端。
 * 三个地址(授权/令牌/用户信息)均为配置页维护的完整 URL;
 * 若历史配置只填了域名,自动补 /cas/oauth2.0/* 路径以保持兼容。
 */
import { Fetch } from '@ones-op/fetch'
import type { OAuthConfig } from './config'

export interface SsoToken {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

function fullUrl(url: string, fallbackPath: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  // 仅域名(无路径)时补默认 CAS OAuth2 路径
  if (/^https?:\/\/[^/]+$/.test(trimmed)) {
    return `${trimmed}${fallbackPath}`
  }
  return trimmed
}

export function buildAuthorizeUrl(oauth: OAuthConfig, redirectUri: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
  })
  return `${fullUrl(oauth.authorizeUrl, '/cas/oauth2.0/authorize')}?${query.toString()}`
}

/** 授权码换 access_token。redirect_uri 必须与授权请求一致,认证平台会校验。 */
export async function exchangeTokenByCode(
  oauth: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<SsoToken> {
  const response = await Fetch(fullUrl(oauth.tokenUrl, '/cas/oauth2.0/accessToken'), {
    method: 'POST',
    params: {
      grant_type: 'authorization_code',
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
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
export async function fetchProfile(profileUrl: string, accessToken: string): Promise<Record<string, any>> {
  const response = await Fetch(fullUrl(profileUrl, '/cas/oauth2.0/profile'), {
    method: 'GET',
    params: { access_token: accessToken },
  })
  return parseBody(response?.data)
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
