/**
 * 插件配置的纯函数部分:结构、默认值、归一化、分段校验、脱敏、密钥合并。
 * 不依赖任何 SDK,可独立做单元测试;实体读写见 config.ts。
 */

export interface OAuthConfig {
  authorizeUrl: string
  tokenUrl: string
  profileUrl: string
  clientId: string
  clientSecret: string
  /** 回调地址;留空时自动使用 ONES 传入的 redirect_url */
  redirectUri: string
}

export interface OaConfig {
  baseUrl: string
  deptPath: string
  empPath: string
  sourceKey: string
  apiSubKey: string
}

export interface H5Config {
  enabled: boolean
  algorithm: string
  secretKey: string
  iv: string
  systemCode: string
  tokenTtlMinutes: number
  verifyUrl: string
}

export interface AccountRuleConfig {
  emailSuffix: string
  rootDeptName: string
  company: string
}

export interface SyncControlConfig {
  excludeEmployeeTypes: string[]
}

export interface SinosureConfig {
  oauth: OAuthConfig
  oa: OaConfig
  h5: H5Config
  account: AccountRuleConfig
  sync: SyncControlConfig
}

export const DEFAULT_DEPT_PATH = '/oa-usermanager/department/appselect'
export const DEFAULT_EMP_PATH = '/oa-usermanager/employee/select'
export const SUPPORTED_H5_ALGORITHMS = ['aes-128-cbc', 'aes-256-cbc', 'aes-128-ecb', 'aes-256-ecb']

export function emptyConfig(): SinosureConfig {
  return {
    oauth: {
      authorizeUrl: '',
      tokenUrl: '',
      profileUrl: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    },
    oa: {
      baseUrl: '',
      deptPath: DEFAULT_DEPT_PATH,
      empPath: DEFAULT_EMP_PATH,
      sourceKey: '',
      apiSubKey: '',
    },
    h5: {
      enabled: false,
      algorithm: 'aes-128-cbc',
      secretKey: '',
      iv: '',
      systemCode: '',
      tokenTtlMinutes: 10,
      verifyUrl: '',
    },
    account: {
      emailSuffix: '@sinosure.cn',
      rootDeptName: '中国出口信用保险公司',
      company: '',
    },
    sync: {
      excludeEmployeeTypes: [],
    },
  }
}

function trimAll(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 宽容地解析配置页提交的任意结构,未提交字段取默认值 */
export function normalizeConfig(raw: unknown): SinosureConfig {
  const defaults = emptyConfig()
  const input = (raw ?? {}) as Record<string, any>
  const oauth = (input.oauth ?? {}) as Record<string, any>
  const oa = (input.oa ?? {}) as Record<string, any>
  const h5 = (input.h5 ?? {}) as Record<string, any>
  const account = (input.account ?? {}) as Record<string, any>
  const sync = (input.sync ?? {}) as Record<string, any>

  return {
    oauth: {
      authorizeUrl: trimAll(oauth.authorizeUrl),
      tokenUrl: trimAll(oauth.tokenUrl),
      profileUrl: trimAll(oauth.profileUrl),
      clientId: trimAll(oauth.clientId),
      clientSecret: trimAll(oauth.clientSecret),
      redirectUri: trimAll(oauth.redirectUri),
    },
    oa: {
      baseUrl: trimAll(oa.baseUrl).replace(/\/+$/, ''),
      deptPath: trimAll(oa.deptPath) || DEFAULT_DEPT_PATH,
      empPath: trimAll(oa.empPath) || DEFAULT_EMP_PATH,
      sourceKey: trimAll(oa.sourceKey),
      apiSubKey: trimAll(oa.apiSubKey),
    },
    h5: {
      enabled: h5.enabled === true || h5.enabled === 'true',
      algorithm: trimAll(h5.algorithm) || 'aes-128-cbc',
      secretKey: trimAll(h5.secretKey),
      iv: trimAll(h5.iv),
      systemCode: trimAll(h5.systemCode),
      tokenTtlMinutes: Number(h5.tokenTtlMinutes) > 0 ? Number(h5.tokenTtlMinutes) : 10,
      verifyUrl: trimAll(h5.verifyUrl),
    },
    account: {
      emailSuffix: trimAll(account.emailSuffix) || defaults.account.emailSuffix,
      rootDeptName: trimAll(account.rootDeptName) || defaults.account.rootDeptName,
      company: trimAll(account.company),
    },
    sync: {
      excludeEmployeeTypes: Array.isArray(sync.excludeEmployeeTypes)
        ? sync.excludeEmployeeTypes.map((t: unknown) => trimAll(t)).filter(Boolean)
        : trimAll(sync.excludeEmployeeTypes)
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean),
    },
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value)
}

export interface ConfigValidation {
  /** 整体可保存(格式层面全部合法) */
  ok: boolean
  errors: string[]
  /** OAuth 2.0 登录能力就绪 */
  oauthReady: boolean
  /** OA 通讯录同步能力就绪 */
  oaReady: boolean
  /** APP H5 登录能力就绪 */
  h5Ready: boolean
}

/**
 * 分段校验:格式错误(整体不允许保存);
 * 能力就绪性(某一段必填缺失只禁用对应能力,不阻断保存其他配置)。
 */
export function validateConfig(config: SinosureConfig): ConfigValidation {
  const errors: string[] = []
  const oauthErrors: string[] = []
  const oaErrors: string[] = []
  const h5Errors: string[] = []

  if (config.oauth.authorizeUrl && !isHttpUrl(config.oauth.authorizeUrl)) {
    errors.push('OAuth 授权地址必须是 http(s):// 开头的完整 URL')
  }
  if (config.oauth.tokenUrl && !isHttpUrl(config.oauth.tokenUrl)) {
    errors.push('OAuth 令牌地址必须是 http(s):// 开头的完整 URL')
  }
  if (config.oauth.profileUrl && !isHttpUrl(config.oauth.profileUrl)) {
    errors.push('OAuth 用户信息地址必须是 http(s):// 开头的完整 URL')
  }
  if (config.oauth.redirectUri && !isHttpUrl(config.oauth.redirectUri)) {
    errors.push('OAuth 回调地址必须是 http(s):// 开头的完整 URL')
  }
  if (!config.oauth.authorizeUrl || !config.oauth.tokenUrl || !config.oauth.profileUrl) {
    oauthErrors.push('缺少授权/令牌/用户信息地址')
  }
  if (!config.oauth.clientId || !config.oauth.clientSecret) {
    oauthErrors.push('缺少客户端标识或客户端密钥')
  }
  if (config.oa.baseUrl && !isHttpUrl(config.oa.baseUrl)) {
    errors.push('OA 接口基础地址必须是 http(s):// 开头的 URL')
  }
  if (!config.oa.baseUrl) {
    oaErrors.push('缺少接口基础地址')
  }
  if (!config.oa.deptPath || !config.oa.empPath) {
    oaErrors.push('缺少部门或人员接口路径')
  }
  if (!config.oa.sourceKey || !config.oa.apiSubKey) {
    oaErrors.push('缺少接口访问凭证')
  }
  if (config.h5.verifyUrl && !isHttpUrl(config.h5.verifyUrl)) {
    errors.push('H5 token 服务端校验地址必须是 http(s):// 开头的 URL')
  }
  if (config.h5.enabled) {
    if (!SUPPORTED_H5_ALGORITHMS.includes(config.h5.algorithm)) {
      h5Errors.push(`不支持的解密算法,当前支持: ${SUPPORTED_H5_ALGORITHMS.join(' / ')}`)
    } else if (!config.h5.secretKey) {
      h5Errors.push('缺少 token 解密密钥')
    }
    if (!config.h5.systemCode) {
      h5Errors.push('缺少系统编码')
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    oauthReady: oauthErrors.length === 0,
    oaReady: oaErrors.length === 0,
    h5Ready: !config.h5.enabled || h5Errors.length === 0,
  }
}

/** 密钥字段永不回显明文:client_id 非密钥(会出现在授权 URL 中),其余密钥替换为已设置标记 */
export function maskConfig(config: SinosureConfig): Record<string, unknown> {
  return {
    ...config,
    oauth: {
      ...config.oauth,
      clientSecret: '',
      clientSecretSet: config.oauth.clientSecret !== '',
    },
    oa: {
      ...config.oa,
      sourceKey: '',
      sourceKeySet: config.oa.sourceKey !== '',
      apiSubKey: '',
      apiSubKeySet: config.oa.apiSubKey !== '',
    },
    h5: {
      ...config.h5,
      secretKey: '',
      secretKeySet: config.h5.secretKey !== '',
    },
  }
}

/** 保存合并规则:密钥字段提交为空字符串且原值已存在时,视为"保持不变" */
export function mergeSecrets(incoming: SinosureConfig, existing: SinosureConfig | null): SinosureConfig {
  if (!existing) {
    return incoming
  }
  const merged = JSON.parse(JSON.stringify(incoming)) as SinosureConfig
  if (!merged.oauth.clientSecret && existing.oauth.clientSecret) {
    merged.oauth.clientSecret = existing.oauth.clientSecret
  }
  if (!merged.oa.sourceKey && existing.oa.sourceKey) {
    merged.oa.sourceKey = existing.oa.sourceKey
  }
  if (!merged.oa.apiSubKey && existing.oa.apiSubKey) {
    merged.oa.apiSubKey = existing.oa.apiSubKey
  }
  if (!merged.h5.secretKey && existing.h5.secretKey) {
    merged.h5.secretKey = existing.h5.secretKey
  }
  return merged
}
