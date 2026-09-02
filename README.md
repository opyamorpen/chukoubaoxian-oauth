# 信保统一认证(中国信保 ONES 单点登录 + 用户目录/组织架构同步插件)

面向中国出口信用保险公司(中国信保/Sinosure)私有化部署 ONES 的**团队级** 1.0 插件(.opk)。
基于开放平台 `account` 业务能力(对接三方系统 v1.0.0,要求 ONES ≥ v3.6.0),一个能力同时实现:

| 功能 | 能力函数 | 对接的客户系统 |
|---|---|---|
| 第三方登录(OAuth2 授权码模式) | `CreateLoginUrl` / `DoExchangeUser` | 单点登录系统(CAS OAuth2.0,`/cas/oauth2.0/*`) |
| 用户目录 + 组织架构全量同步 | `DoPullData` | OA 微服务平台(`/oa-usermanager/*`,X-EOS 双请求头认证) |
| 消息推送 | 未启用(`canMessage=false`,保留桩) | - |

ONES 侧登录页会自动渲染"中国信保统一认证"入口,并**每 10 分钟自动调度一次 DoPullData** 完成目录同步与账号绑定(third_party_id = userid),无需自研定时任务。

## 架构与数据流

```
登录:用户点登录页入口 → ONES 调 CreateLoginUrl(redirect_url)
     → 插件返回 {sso}/cas/oauth2.0/authorize?...&redirect_uri=...
     → 用户在单点系统认证 → 带 code 回跳 ONES → ONES 调 DoExchangeUser(auth_info={code})
     → 插件 POST accessToken 换 token → GET profile(URL 解码中文)
     → 返回 third_party_id=userid → ONES 匹配已同步账号,建立会话

同步(每 10 分钟):ONES 调 DoPullData
     → 插件并发拉 OA 人员/部门两个接口
     → 组装部门树:根部门(-1) → 部门(deptid) → 处室(sectionid)
     → 组装用户:third_party_id=userid,email 缺失时 userid+后缀拼接,title=sortName,
       部门优先处室(divisionNo)→回退部门(departmentNo)→回退根部门
     → ONES 负责创建/更新/软删除(数据源消失即软删除,底层数据保留)
```

关键业务口径(2026-08-31 与客户确认):
- 唯一标识 = userid(邮箱 @ 前缀),单点系统与 OA 目录两套系统一致
- 全量同步(含外包),同步后按需分配许可;一人双账号同步为两个账号(客户接受)
- 无邮箱用户用 userid + 固定后缀(默认 `@sinosure.cn`)拼接邮箱(ONES 建号必须有邮箱)
- 部门负责人/上下级自动维护一期不做(ONES 标品需手动维护,二期评估)

## 配置项(插件详情页,未启用时可修改)

| key | 说明 | 默认值 |
|---|---|---|
| `ssoBaseUrl` | 单点登录服务地址(**文档脱敏,必须向客户要真实域名**) | 空(必填) |
| `clientId` / `clientSecret` | OAuth2 凭据;默认值为文档通用测试凭据,正式凭据向单点服务组申请 | 测试值 |
| `oaBaseUrl` | OA 微服务平台地址;测试 `http://oadev1.sinosure.com.cn`,生产 `http://oa.sinosure.com.cn` | 测试环境 |
| `eosSourceSysKey` / `eosApiSubscriptionKey` | OA 接口认证头;测试/生产密钥不同,见《人员接口文档》 | 测试值 |
| `emailSuffix` | 无邮箱用户拼接后缀 | `@sinosure.cn` |
| `rootDeptName` | ONES 根部门名称 | `中国出口信用保险公司` |
| `company` | 用户 company 字段 | `中国信保` |
| `excludeEmployeeTypes` | 不同步的员工类别,逗号分隔(1个人/21兼职/22外包/23驻场/24交流/25实习/26其他);默认全量 | 空 |

## 构建与部署

```bash
npm run build:test   # npx op packup,测试包(app_id 带 dev_ 前缀)
npm run build:release # npx op packup --release,正式包
npm test             # transform 纯函数单测
```

ONES 端启用:配置中心 → 账号与成员 → 第三方集成 → 添加第三方集成,选中本插件;
或在 配置中心 → 插件管理 安装启用后到"账号同步、登录与通知"开启。

## 实施前待客户补齐的信息

| 事项 | 找谁 |
|---|---|
| 单点系统真实域名(测试/生产,文档脱敏为 `*.com.cn`) | 单点服务组 |
| ONES 专用正式 client_id/secret(申请时登记 ONES 回调地址、要求跳过授权页) | OA 流程(开发四处)→ 单点服务组 |
| ONES 实例 → 单点域名/OA 域名的网络开通 | 数字化运维平台 |
| **部门接口生产环境授权**(文档标注"未授权",不开通则生产无法同步组织架构) | OA 组(devops) |
| 邮箱拼接后缀确认(默认 @sinosure.cn) | OA 组(小韩/徐老师) |
| 二次入职 userid 是否变化、双账号的人力资源编号规则(人员接口 `hrid` 是否即此编号) | OA 组(小韩) |
| 同步频率期望(当前固定为 ONES 每 10 分钟调度) | 客户确认 |

## 已知边界

- profile 接口对无 OA 账号的用户(仅 AD 账号的外包)不返回 attributes,插件会拒绝其登录并提示原因;此类用户若需使用 ONES,须先解决目录覆盖问题
- `state=0`(RBAC 无效)用户拒绝登录
- 人员接口不含临时部门人员;员工类别过滤见配置项
- 单点退出不做联动(OAuth2 下游收不到退出通知,8/31 会议确认);单点侧 logout 地址 `{sso}/cas/oauth2.0/logout?service=...` 已在 ssoClient 中预留
- code 换 token 时 redirect_uri 必须与授权请求一致,插件将其存于实体存储 `sso_state`,以最后一次 CreateLoginUrl 的值为准

## 目录结构

```
backend/src/
  account.ts            # account 能力四函数(官方模板响应结构)
  index.ts              # 团队级生命周期
  lib/settings.ts       # 读取 service.config 插件配置(Plugin.getPluginConfig)
  lib/ssoClient.ts      # OAuth2:authorize/accessToken/profile/logout
  lib/oaClient.ts       # OA:employee/select、department/appselect(X-EOS 头)
  lib/transform.ts      # 纯函数转换层(部门树/用户映射/profile 解码),可独立单测
backend/test/           # node --test 单测
web/public/logo.svg     # 登录入口 logo
config/plugin.yaml      # 团队级 + account 能力 + service.config + storage 实体
```
