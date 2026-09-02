import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyConfig, maskConfig, mergeSecrets, normalizeConfig, validateConfig } from '../src/lib/configSchema.ts'

function validOAuth() {
  return {
    authorizeUrl: 'https://sso.example.com.cn/cas/oauth2.0/authorize',
    tokenUrl: 'https://sso.example.com.cn/cas/oauth2.0/accessToken',
    profileUrl: 'https://sso.example.com.cn/cas/oauth2.0/profile',
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: '',
  }
}

function validOa() {
  return {
    baseUrl: 'http://oadev1.sinosure.com.cn',
    deptPath: '/oa-usermanager/department/appselect',
    empPath: '/oa-usermanager/employee/select',
    sourceKey: 'sk',
    apiSubKey: 'ak',
  }
}

test('空配置:可保存(格式合法)但所有能力未就绪', () => {
  const config = emptyConfig()
  const validation = validateConfig(config)
  assert.equal(validation.ok, true)
  assert.equal(validation.oauthReady, false)
  assert.equal(validation.oaReady, false)
  assert.equal(validation.h5Ready, true) // 未启用 H5 时不校验
})

test('分段就绪:OAuth 完整 + OA 缺凭证 -> 仅登录就绪', () => {
  const config = emptyConfig()
  config.oauth = validOAuth()
  config.oa = { ...validOa(), sourceKey: '', apiSubKey: '' }
  const validation = validateConfig(config)
  assert.equal(validation.ok, true)
  assert.equal(validation.oauthReady, true)
  assert.equal(validation.oaReady, false)
})

test('格式错误:URL 非法时整体拒绝保存', () => {
  const config = emptyConfig()
  config.oauth = { ...validOAuth(), authorizeUrl: 'not-a-url' }
  const validation = validateConfig(config)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((e) => e.includes('授权地址')))
})

test('H5 启用时校验算法/密钥/系统编码', () => {
  const config = emptyConfig()
  config.h5.enabled = true
  let validation = validateConfig(config)
  assert.equal(validation.h5Ready, false)

  config.h5.algorithm = 'aes-128-cbc'
  config.h5.secretKey = 'key'
  validation = validateConfig(config)
  assert.equal(validation.h5Ready, false) // 缺系统编码

  config.h5.systemCode = 'ONES'
  validation = validateConfig(config)
  assert.equal(validation.h5Ready, true)

  config.h5.algorithm = 'rsa'
  validation = validateConfig(config)
  assert.equal(validation.h5Ready, false)
  assert.ok(validation.errors.length === 0 || validation.ok === true)
})

test('normalizeConfig:字符串员工类别转数组、默认路径与后缀兜底', () => {
  const config = normalizeConfig({
    sync: { excludeEmployeeTypes: '25, 26,,' },
    oa: { baseUrl: 'http://x.example.com/' },
  })
  assert.deepEqual(config.sync.excludeEmployeeTypes, ['25', '26'])
  assert.equal(config.oa.baseUrl, 'http://x.example.com')
  assert.equal(config.oa.deptPath, '/oa-usermanager/department/appselect')
  assert.equal(config.account.emailSuffix, '@sinosure.cn')
})

test('mergeSecrets:空字符串密钥保持原值', () => {
  const existing = emptyConfig()
  existing.oauth.clientSecret = 'old-secret'
  existing.oa.sourceKey = 'old-sk'
  existing.h5.secretKey = 'old-h5'
  const incoming = emptyConfig()
  incoming.oauth.clientId = 'cid'
  const merged = mergeSecrets(incoming, existing)
  assert.equal(merged.oauth.clientSecret, 'old-secret')
  assert.equal(merged.oa.sourceKey, 'old-sk')
  assert.equal(merged.h5.secretKey, 'old-h5')
  // 无原值时不凭空补
  assert.equal(merged.oauth.clientId, 'cid')
  assert.equal(merged.oa.apiSubKey, '')
})

test('maskConfig:密钥不回显,标记已设置', () => {
  const config = emptyConfig()
  config.oauth = validOAuth()
  const masked = maskConfig(config)
  assert.equal(masked.oauth.clientSecret, '')
  assert.equal(masked.oauth.clientSecretSet, true)
  assert.equal(masked.oauth.clientId, 'cid')
  assert.equal(masked.oauth.clientSecretSet, true)

  const maskedEmpty = maskConfig(emptyConfig())
  assert.equal(maskedEmpty.oauth.clientSecretSet, false)
})
