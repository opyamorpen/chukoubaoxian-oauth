/**
 * APP H5 登录入口(about:blank 模块,客户 APP 携带 token 打开本页地址)。
 * 流程:读取 URL 中 token -> 调插件 /h5/verify(解密+有效期+系统编码+可选服务端校验)
 * -> 校验通过后携带一次性 code 重定向到 ONES 第三方登录回调,完成登录会话建立。
 * 任一环节失败:中文提示,不建立 ONES 登录会话。
 */
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { env } from '@ones-op/sdk/web'
import { OPFetch } from '@ones-op/fetch'
import { lifecycle, OPProvider } from '@ones-op/bridge'
import { Typography } from '@ones-design/core'
import './index.css'

const { Text } = Typography

function App() {
  const [message, setMessage] = useState('正在验证登录凭证…')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const token = params.get('token') ?? ''
        if (!token) {
          setFailed(true)
          setMessage('登录失败:URL 中缺少 token,请从客户 APP 重新进入')
          return
        }
        const appId = await env.getAppId()
        let response: any
        try {
          response = await OPFetch(`/api/plugin/${appId}/h5/verify`, {
            method: 'POST',
            data: { token },
          })
        } catch (error: any) {
          if (String(appId).startsWith('dev_')) {
            response = await OPFetch(`/api/plugin/${String(appId).slice(4)}/h5/verify`, {
              method: 'POST',
              data: { token },
            })
          } else {
            throw error
          }
        }
        const payload = response?.data ?? response
        const body = payload && typeof payload === 'object' && 'body' in payload ? payload.body : payload
        if (body?.ok && body?.redirect) {
          setMessage('验证通过,正在进入 ONES…')
          window.location.href = String(body.redirect)
          return
        }
        setFailed(true)
        setMessage(`登录失败:${body?.reason ?? 'token 校验未通过'}`)
      } catch (error: any) {
        setFailed(true)
        setMessage(`登录失败:${error?.response?.data?.reason ?? error?.message ?? '验证服务不可用'}`)
      }
    })()
  }, [])

  return (
    <div className="sinosure-h5-entry">
      <div className="sinosure-h5-title">统一身份登录</div>
      <Text className={failed ? 'sinosure-danger' : 'sinosure-secondary'}>{message}</Text>
      {failed ? (
        <Text className="sinosure-secondary">请退回客户 APP 重新进入,或联系管理员检查插件配置</Text>
      ) : null}
    </div>
  )
}

// @ones-protected:begin id=tsx-react-template label=插件代码模板
const rootElement = document.getElementById('ones-mf-root')

if (rootElement) {
  rootElement.classList.add('sinosure-h5-entry-root')
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
