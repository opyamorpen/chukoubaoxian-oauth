/**
 * 「统一身份与组织同步配置」页(settings 模块,插件启用后可访问)。
 * 五个配置区:OAuth 2.0 / OA 通讯录 / APP H5 登录 / 账号规则 / 同步控制。
 * 密钥字段保存后不回显明文,留空提交表示保持不变。
 */
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { env } from '@ones-op/sdk/web'
import { OPFetch } from '@ones-op/fetch'
import { lifecycle, OPProvider } from '@ones-op/bridge'
import { Alert, Button, Divider, Switch, Tabs, Tag, toast, Typography } from '@ones-design/core'
import type { InputProps } from '@ones-design/core'
import { Input, InputNumber, Select } from '@ones-design/core'
import './index.css'

const { Text } = Typography

// Input/Select 的类型声明对原生属性可选项处理有误(crossOrigin 被标记为必填),
// 运行时 props 正确,这里仅绕开类型检查
const SInput = Input as unknown as React.ComponentType<InputProps & { type?: string; value?: string; placeholder?: string; onChange?: (e: any) => void }>
const SSelect = Select as unknown as React.ComponentType<{ value?: string; onChange?: (v: any) => void; options?: Array<{ label: string; value: string }> }>
const SInputNumber = InputNumber as unknown as React.ComponentType<{ value?: number; min?: number; onChange?: (v: any) => void }>

interface PluginConfig {
  oauth: {
    authorizeUrl: string
    tokenUrl: string
    profileUrl: string
    clientId: string
    clientSecret: string
    redirectUri: string
  }
  oa: {
    baseUrl: string
    deptPath: string
    empPath: string
    sourceKey: string
    apiSubKey: string
  }
  h5: {
    enabled: boolean
    algorithm: string
    secretKey: string
    iv: string
    systemCode: string
    tokenTtlMinutes: number
    verifyUrl: string
  }
  account: {
    emailSuffix: string
    rootDeptName: string
    company: string
  }
  sync: {
    excludeEmployeeTypes: string[]
  }
  clientSecretSet?: boolean
  sourceKeySet?: boolean
  apiSubKeySet?: boolean
  secretKeySet?: boolean
}

const EMPTY_CONFIG: PluginConfig = {
  oauth: { authorizeUrl: '', tokenUrl: '', profileUrl: '', clientId: '', clientSecret: '', redirectUri: '' },
  oa: {
    baseUrl: '',
    deptPath: '/oa-usermanager/department/appselect',
    empPath: '/oa-usermanager/employee/select',
    sourceKey: '',
    apiSubKey: '',
  },
  h5: { enabled: false, algorithm: 'aes-128-cbc', secretKey: '', iv: '', systemCode: '', tokenTtlMinutes: 10, verifyUrl: '' },
  account: { emailSuffix: '@sinosure.cn', rootDeptName: '中国出口信用保险公司', company: '' },
  sync: { excludeEmployeeTypes: [] },
}

const TABS = [
  { key: 'oauth', tabKey: 'oauth', label: 'OAuth 2.0' },
  { key: 'oa', tabKey: 'oa', label: 'OA 通讯录' },
  { key: 'h5', tabKey: 'h5', label: 'APP H5 登录' },
  { key: 'rules', tabKey: 'rules', label: '账号规则' },
  { key: 'sync', tabKey: 'sync', label: '同步控制' },
]

async function callApi(path: string, body: Record<string, unknown> = {}): Promise<any> {
  const appId = await env.getAppId()
  const instanceId = await env.getInstanceId()
  const teamID = await env.getTeamID()
  const headers: Record<string, string> = {
    'Ones-Plugin-Id': instanceId,
    'Ones-Check-Point': 'team',
    'Ones-Check-Id': teamID,
  }
  const request = (id: string) => OPFetch(`/api/plugin/${id}${path}`, { method: 'POST', data: body, headers })
  try {
    return await request(appId)
  } catch (error: any) {
    // 调试态 app_id 带 dev_ 前缀时部分网关不识别,去前缀重试一次
    if (String(appId).startsWith('dev_')) {
      return await request(String(appId).slice(4))
    }
    throw error
  }
}

function unwrap(response: any): any {
  const payload = response?.data ?? response
  if (payload && typeof payload === 'object' && 'body' in payload) {
    return payload.body
  }
  return payload
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="sinosure-section">
      <div className="sinosure-section-title">{title}</div>
      {desc ? <Text className="sinosure-secondary">{desc}</Text> : null}
      <div className="sinosure-section-body">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="sinosure-field">
      <div className="sinosure-field-label">{label}</div>
      {children}
      {hint ? <Text className="sinosure-secondary sinosure-field-hint">{hint}</Text> : null}
    </div>
  )
}

function App() {
  const [config, setConfig] = useState<PluginConfig>(EMPTY_CONFIG)
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [activeTab, setActiveTab] = useState('oauth')
  const [latest, setLatest] = useState<Record<string, any> | null>(null)
  const [readiness, setReadiness] = useState({ oauthReady: false, oaReady: false, h5Ready: true })
  const [manualResult, setManualResult] = useState('')

  const loadAll = async () => {
    try {
      const result = unwrap(await callApi('/config/get')) ?? {}
      if (result.config) {
        setConfig({ ...EMPTY_CONFIG, ...result.config })
      }
      setConfigured(!!result.configured)
      setReadiness({
        oauthReady: !!result.validation?.oauthReady,
        oaReady: !!result.validation?.oaReady,
        h5Ready: !!result.validation?.h5Ready,
      })
      const syncResult = unwrap(await callApi('/sync/status')) ?? {}
      setLatest(syncResult.latest ?? null)
    } catch (error: any) {
      toast.error(`读取配置失败: ${error?.response?.data?.reason ?? error?.message ?? error}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  const patch = (section: keyof PluginConfig, key: string, value: unknown) => {
    setConfig((prev) => ({
      ...prev,
      [section]: { ...(prev[section] as Record<string, unknown>), [key]: value },
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = unwrap(await callApi('/config/save', { config }))
      if (result?.ok) {
        toast.success('配置已保存')
        if (result.config) {
          setConfig({ ...EMPTY_CONFIG, ...result.config })
        }
        await loadAll()
      } else {
        const errors = (result?.errors ?? [result?.reason]).filter(Boolean).join(';')
        toast.error(`保存失败: ${errors || '未知错误'}`)
      }
    } catch (error: any) {
      toast.error(`保存失败: ${error?.response?.data?.reason ?? error?.message ?? error}`)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (target: 'oa' | 'oauth') => {
    setTesting(target)
    try {
      const result = unwrap(await callApi('/config/test', { target }))
      if (result?.ok) {
        toast.success(result.detail ?? '连接成功')
      } else {
        toast.error(result?.reason ?? '测试失败')
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.reason ?? error?.message ?? error)
    } finally {
      setTesting('')
    }
  }

  const handleManualSync = async () => {
    setSyncing(true)
    setManualResult('')
    try {
      const result = unwrap(await callApi('/sync/manual'))
      if (result?.ok) {
        setManualResult(
          `同步完成:部门 ${result.deptCount}(含根部门),用户 ${result.userCount},跳过 ${result.skippedCount},保留消失部门 ${result.preservedDeptCount}`,
        )
        toast.success('手动同步完成')
        const syncResult = unwrap(await callApi('/sync/status')) ?? {}
        setLatest(syncResult.latest ?? null)
      } else {
        setManualResult(`同步失败: ${result?.reason ?? '未知错误'}`)
        toast.error(result?.reason ?? '同步失败')
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.reason ?? error?.message ?? error)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return <div className="sinosure-loading">加载中…</div>
  }

  const oauthSection = (
    <Section title="OAuth 2.0(网页端 / OA 门户统一身份登录)" desc="必填项不完整时,不启用 OAuth 2.0 登录;ONES 本地账号密码登录始终保留。">
      <Field label="授权地址 *" hint="客户统一认证授权地址,发起授权码登录">
        <SInput
          value={config.oauth.authorizeUrl}
          placeholder="https://sso.example.com.cn/cas/oauth2.0/authorize"
          onChange={(e: any) => patch('oauth', 'authorizeUrl', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="令牌地址 *" hint="授权码换取访问令牌的地址">
        <SInput
          value={config.oauth.tokenUrl}
          placeholder="https://sso.example.com.cn/cas/oauth2.0/accessToken"
          onChange={(e: any) => patch('oauth', 'tokenUrl', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="用户信息地址 *" hint="返回信息必须包含 userid">
        <SInput
          value={config.oauth.profileUrl}
          placeholder="https://sso.example.com.cn/cas/oauth2.0/profile"
          onChange={(e: any) => patch('oauth', 'profileUrl', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="客户端标识(client_id)*">
        <SInput value={config.oauth.clientId} onChange={(e: any) => patch('oauth', 'clientId', e?.target?.value ?? e)} />
      </Field>
      <Field
        label="客户端密钥(client_secret)*"
        hint={config.clientSecretSet ? '已保存(不回显);留空提交表示保持不变' : undefined}
      >
        <SInput
          type="password"
          value={config.oauth.clientSecret}
          placeholder={config.clientSecretSet ? '••••••••(留空保持不变)' : ''}
          onChange={(e: any) => patch('oauth', 'clientSecret', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="回调地址" hint="客户统一认证完成后返回 ONES 的地址,需与客户侧登记一致;留空时自动使用 ONES 登录流程传入的回调">
        <SInput
          value={config.oauth.redirectUri}
          placeholder="留空自动使用 ONES 回调"
          onChange={(e: any) => patch('oauth', 'redirectUri', e?.target?.value ?? e)}
        />
      </Field>
      <Button loading={testing === 'oauth'} onClick={() => void handleTest('oauth')}>
        测试授权地址连通性
      </Button>
    </Section>
  )

  const oaSection = (
    <Section title="OA 通讯录(组织与人员数据源)" desc="任一必填接口不可访问或未授权时,不执行本次同步;本期不从其他数据源补充 OA 未返回的人员。">
      <Field label="接口基础地址 *" hint="OA 测试或生产环境地址">
        <SInput
          value={config.oa.baseUrl}
          placeholder="http://oadev1.sinosure.com.cn"
          onChange={(e: any) => patch('oa', 'baseUrl', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="一级部门与二级处室接口 *" hint="仅同步接口返回的两级结构">
        <SInput value={config.oa.deptPath} onChange={(e: any) => patch('oa', 'deptPath', e?.target?.value ?? e)} />
      </Field>
      <Field label="人员接口 *" hint="仅同步该接口返回的有效人员">
        <SInput value={config.oa.empPath} onChange={(e: any) => patch('oa', 'empPath', e?.target?.value ?? e)} />
      </Field>
      <Field label="访问凭证 X-EOS-SourceSysKey *" hint={config.sourceKeySet ? '已保存(不回显);留空提交表示保持不变' : undefined}>
        <SInput
          type="password"
          value={config.oa.sourceKey}
          placeholder={config.sourceKeySet ? '••••••••(留空保持不变)' : ''}
          onChange={(e: any) => patch('oa', 'sourceKey', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="访问凭证 X-EOS-ApiSubScriptionKey *" hint={config.apiSubKeySet ? '已保存(不回显);留空提交表示保持不变' : undefined}>
        <SInput
          type="password"
          value={config.oa.apiSubKey}
          placeholder={config.apiSubKeySet ? '••••••••(留空保持不变)' : ''}
          onChange={(e: any) => patch('oa', 'apiSubKey', e?.target?.value ?? e)}
        />
      </Field>
      <Button loading={testing === 'oa'} onClick={() => void handleTest('oa')}>
        测试接口连通性
      </Button>
    </Section>
  )

  const h5Section = (
    <Section title="APP H5 登录" desc="客户 APP 通过 H5 地址携带 token 进入 ONES;token 缺失、解密失败、过期、系统编码不匹配或二次校验失败时拒绝登录。">
      <Field label="启用 APP H5 登录">
        <Switch checked={config.h5.enabled} onChange={(v: any) => patch('h5', 'enabled', v)} />
      </Field>
      <Field label="解密算法 *" hint="按客户 token 协议选择;客户规则到位后如有出入请联系开发适配">
        <SSelect
          value={config.h5.algorithm}
          onChange={(v: any) => patch('h5', 'algorithm', v)}
          options={[
            { label: 'AES-128-CBC', value: 'aes-128-cbc' },
            { label: 'AES-256-CBC', value: 'aes-256-cbc' },
            { label: 'AES-128-ECB', value: 'aes-128-ecb' },
            { label: 'AES-256-ECB', value: 'aes-256-ecb' },
          ]}
        />
      </Field>
      <Field label="token 解密密钥 *" hint="hex 或 utf8;CBC 模式另需 IV。密钥保存后不回显">
        <SInput
          type="password"
          value={config.h5.secretKey}
          placeholder={config.secretKeySet ? '••••••••(留空保持不变)' : ''}
          onChange={(e: any) => patch('h5', 'secretKey', e?.target?.value ?? e)}
        />
      </Field>
      <Field label="CBC 模式 IV" hint="hex 或 utf8(16 字节);ECB 模式无需填写">
        <SInput value={config.h5.iv} onChange={(e: any) => patch('h5', 'iv', e?.target?.value ?? e)} />
      </Field>
      <Field label="系统编码 *" hint="客户 APP 分配的外部系统编码,token 中携带时必须一致">
        <SInput value={config.h5.systemCode} onChange={(e: any) => patch('h5', 'systemCode', e?.target?.value ?? e)} />
      </Field>
      <Field label="token 有效期(分钟)*">
        <SInputNumber value={config.h5.tokenTtlMinutes} min={1} onChange={(v: any) => patch('h5', 'tokenTtlMinutes', Number(v) || 10)} />
      </Field>
      <Field label="token 服务端校验地址" hint="可选;配置后在解密成功后继续调用该接口二次校验">
        <SInput value={config.h5.verifyUrl} onChange={(e: any) => patch('h5', 'verifyUrl', e?.target?.value ?? e)} />
      </Field>
    </Section>
  )

  const rulesSection = (
    <Section title="账号规则" desc="人员唯一标识固定使用 OA userid,不支持改为 hrid;同一自然人多个 userid 分别对应不同 ONES 账号。">
      <Field label="虚拟邮箱域名后缀 *" hint="无邮箱人员按 userid+后缀生成邮箱;首次以虚拟邮箱创建后,OA 补齐真实邮箱也不自动覆盖">
        <SInput value={config.account.emailSuffix} onChange={(e: any) => patch('account', 'emailSuffix', e?.target?.value ?? e)} />
      </Field>
      <Field label="ONES 根部门名称 *">
        <SInput value={config.account.rootDeptName} onChange={(e: any) => patch('account', 'rootDeptName', e?.target?.value ?? e)} />
      </Field>
      <Field label="用户 company 字段">
        <SInput value={config.account.company} onChange={(e: any) => patch('account', 'company', e?.target?.value ?? e)} />
      </Field>
      <Field label="不同步的员工类别" hint="逗号分隔:1个人,21兼职,22外包,23驻场,24交流,25实习,26其他;留空表示全量同步">
        <SInput
          value={config.sync.excludeEmployeeTypes.join(',')}
          placeholder="例如:25,26"
          onChange={(e: any) =>
            patch(
              'sync',
              'excludeEmployeeTypes',
              String(e?.target?.value ?? e)
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
    </Section>
  )

  const syncSection = (
    <Section title="同步控制" desc="自动同步周期固定为每 10 分钟一次全量拉取与差异处理;手动同步与自动同步重叠时只保留一个执行中的任务。">
      <div className="sinosure-sync-status">
        <Text>上次同步:</Text>
        {latest ? (
          <div className="sinosure-sync-detail">
            <span>
              <Tag color={latest.error ? 'error' : 'success'}>{latest.error ? '失败' : '成功'}</Tag>
              <Text className="sinosure-secondary">{String(latest.pulled_at ?? '')}</Text>
            </span>
            <span className="sinosure-secondary">
              部门 {String(latest.dept_count ?? 0)} · 用户 {String(latest.user_count ?? 0)} · 跳过 {String(latest.skipped_count ?? 0)} · 保留消失部门{' '}
              {String(latest.preserved_dept_count ?? 0)} · 触发:{String(latest.trigger ?? '-')}
            </span>
            {latest.error ? <span className="sinosure-danger">{String(latest.error)}</span> : null}
          </div>
        ) : (
          <Text className="sinosure-secondary">尚未执行</Text>
        )}
      </div>
      <Divider />
      <div>
        <Button type="primary" loading={syncing} onClick={() => void handleManualSync()}>
          立即手动同步
        </Button>
        <Text className="sinosure-secondary" style={{ marginLeft: 12 }}>
          手动同步立即拉取并校验数据、生成报告;ONES 侧组织人员落库随每 10 分钟自动调度生效,手动失败不影响后续自动同步。
        </Text>
      </div>
      {manualResult ? (
        <Alert type={manualResult.startsWith('同步失败') ? 'error' : 'info'}>{manualResult}</Alert>
      ) : null}
    </Section>
  )

  const sections: Record<string, React.ReactNode> = {
    oauth: oauthSection,
    oa: oaSection,
    h5: h5Section,
    rules: rulesSection,
    sync: syncSection,
  }

  return (
    <div className="sinosure-settings">
      <div className="sinosure-header">
        <div className="sinosure-page-title">统一身份与组织同步配置</div>
        <div className="sinosure-tags">
          <Tag color={readiness.oauthReady ? 'success' : 'warning'}>
            OAuth 2.0 登录{readiness.oauthReady ? '就绪' : '未配置完整'}
          </Tag>
          <Tag color={readiness.oaReady ? 'success' : 'warning'}>
            组织人员同步{readiness.oaReady ? '就绪' : '未配置完整'}
          </Tag>
          <Tag color={config.h5.enabled ? (readiness.h5Ready ? 'success' : 'warning') : 'default'}>
            APP H5 登录{config.h5.enabled ? (readiness.h5Ready ? '就绪' : '配置不完整') : '未启用'}
          </Tag>
        </div>
        {!configured ? (
          <Alert type="info">
            首次使用请完成必填配置后保存;OAuth 段不完整时仅影响统一身份登录,OA 段不完整时不执行同步,ONES
            本地账号密码登录不受影响。
          </Alert>
        ) : null}
      </div>

      <Tabs tabs={TABS} activeTabKey={activeTab} onTabClick={(p: any) => setActiveTab(String(p.key))} />
      <div className="sinosure-tab-content">{sections[activeTab]}</div>

      <Divider />
      <div className="sinosure-footer">
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          保存配置
        </Button>
        <Text className="sinosure-secondary" style={{ marginLeft: 12 }}>
          配置校验失败时保留上一份有效配置;密钥留空提交表示保持不变。
        </Text>
      </div>
    </div>
  )
}

// @ones-protected:begin id=tsx-react-template label=插件代码模板
const rootElement = document.getElementById('ones-mf-root')

if (rootElement) {
  rootElement.classList.add('sinosure-settings-root')
}
ReactDOM.render(
  <OPProvider>
    <App />
  </OPProvider>,
  rootElement,
)

lifecycle.onDestroy(() => {
  if (rootElement) {
    ReactDOM.unmountComponentAtNode(rootElement)
  }
})
// @ones-protected:end id=tsx-react-template
