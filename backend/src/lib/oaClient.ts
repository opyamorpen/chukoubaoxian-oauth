/**
 * 客户 OA 微服务平台接口客户端(用户目录 + 组织架构)。
 * 接口基础地址与两个接口路径均由配置页维护;
 * 认证为两个静态请求头 X-EOS-SourceSysKey / X-EOS-ApiSubScriptionKey。
 */
import { Fetch } from '@ones-op/fetch'
import type { OaConfig } from './config'

interface OaEnvelope {
  status?: string | number
  message?: string
  data?: unknown[]
}

async function fetchOaList(config: OaConfig, path: string, what: string): Promise<unknown[]> {
  let response
  try {
    response = await Fetch(`${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
      method: 'GET',
      headers: {
        'X-EOS-SourceSysKey': config.sourceKey,
        'X-EOS-ApiSubScriptionKey': config.apiSubKey,
      },
    })
  } catch (error) {
    throw new Error(`请求 OA ${what}接口失败(检查网络与地址配置): ${(error as Error)?.message ?? error}`)
  }

  const body = (response?.data ?? {}) as OaEnvelope
  const status = String(body.status ?? '')
  if (status !== '200') {
    throw new Error(`OA ${what}接口返回异常 status=${status || '空'} message=${body.message ?? ''}`)
  }
  if (!Array.isArray(body.data)) {
    throw new Error(`OA ${what}接口返回的 data 不是数组`)
  }
  return body.data
}

export async function fetchOaEmployees(config: OaConfig): Promise<unknown[]> {
  return fetchOaList(config, config.empPath, '人员')
}

export async function fetchOaDepartments(config: OaConfig): Promise<unknown[]> {
  return fetchOaList(config, config.deptPath, '部门')
}
