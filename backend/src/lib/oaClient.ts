/**
 * 客户 OA 微服务平台接口客户端(用户目录 + 组织架构)。
 * 接口依据《人员接口文档》《企业微信通讯录获取所有一级及二级部门》:
 *   GET {base}/oa-usermanager/employee/select    全量人员(不含临时部门)
 *   GET {base}/oa-usermanager/department/appselect 全量一级部门与二级处室
 * 认证:两个静态请求头 X-EOS-SourceSysKey / X-EOS-ApiSubScriptionKey。
 */
import { Fetch } from '@ones-op/fetch'

export interface OaCredentials {
  oaBaseUrl: string
  eosSourceSysKey: string
  eosApiSubscriptionKey: string
}

const EMPLOYEE_PATH = '/oa-usermanager/employee/select'
const DEPARTMENT_PATH = '/oa-usermanager/department/appselect'

interface OaEnvelope {
  status?: string | number
  message?: string
  data?: unknown[]
}

async function fetchOaList(credentials: OaCredentials, path: string, what: string): Promise<unknown[]> {
  let response
  try {
    response = await Fetch(`${credentials.oaBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      headers: {
        'X-EOS-SourceSysKey': credentials.eosSourceSysKey,
        'X-EOS-ApiSubScriptionKey': credentials.eosApiSubscriptionKey,
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

export async function fetchOaEmployees(credentials: OaCredentials): Promise<unknown[]> {
  return fetchOaList(credentials, EMPLOYEE_PATH, '人员')
}

export async function fetchOaDepartments(credentials: OaCredentials): Promise<unknown[]> {
  return fetchOaList(credentials, DEPARTMENT_PATH, '部门')
}
