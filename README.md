# 统一身份登录与组织同步(中国信保 ONES 插件)

面向中国出口信用保险公司(中国信保/Sinosure)私有化部署 ONES 的**团队级** 1.0 插件(.opk)。
基于开放平台 `account` 业务能力(对接三方系统 v1.0.0,ONES ≥ v3.6.0,仅私有部署),一个能力覆盖:

| 功能 | 入口 | 实现位置 |
|---|---|---|
| 网页端/OA 门户 OAuth 2.0 单点登录 | ONES 登录页「统一身份登录」 | `CreateLoginUrl` / `DoExchangeUser` |
| 组织与人员全量同步(两级部门+处室) | ONES 每 10 分钟自动调度;配置页可手动触发 | `DoPullData` / `syncEngine` |
| 客户 APP H5 token 登录 | 客户 APP 打开 H5 入口页携带 token | `about:blank` 模块 + `/h5/verify` + 一次性 code |
| 配置管理 | 插件详情页「统一身份与组织同步配置」 | `settings` 模块 + 实体存储 |

ONES 本地账号密码登录始终保留;插件停用后停止同步与外部登录建会话,已同步数据保留。

## 架构与数据流

```
网页端登录:登录页入口 -> CreateLoginUrl(授权地址+回调) -> 统一认证平台认证
  -> 回调携带 code -> ONES 调 DoExchangeUser -> code 换 token -> 拉用户信息(userid)
  -> 匹配已同步账号建立会话

APP H5 登录:客户 APP 打开 H5 入口页(?token=xx) -> /h5/verify
  -> 解密(AES-CBC/ECB)+时间戳有效期+系统编码+可选服务端二次校验
  -> 签发 120 秒一次性 code -> 重定向 ONES 第三方登录回调 -> DoExchangeUser 消费 code 完成登录

组织同步(每 10 分钟 / 手动):拉 OA 人员+部门接口
  -> 根部门(-1)-部门-处室 树 + 用户列表(userid 唯一标识)
  -> 邮箱保留规则 / 消失部门保留 -> ONES 创建/更新/停用(软删除,历史数据保留)
```

## 配置(插件启用后,「统一身份与组织同步配置」页)

| 配置区 | 关键项 | 说明 |
|---|---|---|
| OAuth 2.0 | 授权/令牌/用户信息地址、client_id/secret、回调地址 | 必填不完整时仅禁用 OAuth 登录;回调留空自动用 ONES 传入值;client_secret 不回显 |
| OA 通讯录 | 基础地址、部门/人员接口路径、X-EOS 双凭证 | 任一接口失败本次同步不执行、不变更现有数据;凭证不回显 |
| APP H5 登录 | 启用开关、算法(AES-128/256 CBC/ECB)、密钥/IV、系统编码、token 有效期、服务端校验地址(可选) | token 规则待客户提供后按样例适配参数 |
| 账号规则 | 虚拟邮箱后缀、根部门名、company、不同步员工类别 | 唯一标识固定 userid;虚拟邮箱创建后不因 OA 补齐真实邮箱而覆盖 |
| 同步控制 | 周期说明(固定 10 分钟)、上次同步状态、手动同步按钮 | 手动=立即拉取+校验+报告(互斥锁防重入);ONES 侧落库随自动调度生效 |

保存校验失败保留上一份有效配置;密钥留空提交表示保持不变。

## 同步规则要点(方案确认版)

- userid 唯一匹配;同一自然人多个 userid 分别对应不同 ONES 账号,不合并、不用 hrid
- OA 返回合法邮箱首次创建使用;虚拟邮箱粘性;同批次邮箱冲突后者跳过并记录
- userid 从数据源消失 → ONES 停用账号(软删除,历史数据保留);重新出现恢复原账号
- OA 消失的部门:仍被有效人员引用则保留在返回树中(人员归属不断裂);DoPullData 契约无"停用"标记,保留动作记录在审计告警中
- 任一 OA 接口失败/数据集不完整 → 本次不执行任何停用,保留上一次成功结果
- 不自动分配许可;不处理多级上级/部门负责人/正副职(二期)

## 构建与部署

```bash
npm run build:test    # 测试包(dev_ 前缀 app_id)
npm run build:release # 正式包
npm test              # 纯函数单测(transform/h5Token/configSchema)
```

ONES 端:**带 account 能力的插件不在「应用管理 → 团队插件」上传(会报 `plugin type not support`)**。正确入口:

1. 配置中心 → 插件配置(插件管理)→ **「账号同步、登录与通知」** 子选项 → 右上角"安装或升级" → 上传 `.opk` → 开始安装并启用
2. 配置中心 → 账号与成员 → **第三方集成** → "添加第三方集成" → 选中本插件
3. 在「统一身份与组织同步配置」页完成必填配置后启用各功能

若实例上看不到「账号同步、登录与通知」分类:确认 ONES ≥ v3.6.0 且为私有部署,并检查部署配置 `enablePlugin: true` 是否开启。

## ⚠️ 实现期待验证项(测试环境联调时优先确认)

1. **H5 会话链路**:依赖"一次性 code 重定向到 ONES 第三方登录回调"的契约,以及 H5 模块页(`about:blank` 模块)未登录态可访问;若回调与登录会话绑定导致重放失败,**降级方案**:客户 APP webview 直接走 OAuth 2.0 免登(SSO 会话 cookie 复用)。
2. 配置页插件 API 路径(`/api/plugin/{app_id}/*`)在目标 ONES 版本的可达性(部分老版本 settings 沙箱存在 cookie 隔离问题)。
3. ONES 第三方集成是否原生提供"立即同步"按钮(有则以原生入口为准)。
4. userid 消失→停用/重现→恢复的具体表现以 ONES 账号同步引擎实际行为为准。

## 安全

- 所有密钥(client_secret、X-EOS 凭证、H5 解密密钥)仅存于插件实体存储,配置页不回显、日志不输出
- plugin.yaml/代码/文档中不内置任何凭证;早期文档示例凭证建议按方案 3.2 在上线前由客户轮换
- H5 一次性 code 120 秒过期、单次使用;token 校验失败/过期/编码不匹配一律拒绝建立会话

## 目录结构

```
backend/src/
  account.ts            # account 能力四函数(H5 一次性 code 优先消费)
  api.ts                # 插件 API:config/get|save|test、sync/manual|status、h5/verify
  index.ts              # 团队级生命周期
  lib/configSchema.ts   # 配置结构/分段校验/脱敏/密钥合并(纯函数)
  lib/config.ts         # 配置实体读写(plugin_config)
  lib/ssoClient.ts      # OAuth2:authorize/accessToken/profile(完整 URL 配置)
  lib/oaClient.ts       # OA 接口(路径可配置,X-EOS 头)
  lib/transform.ts      # 部门树/用户映射/邮箱保留/消失部门保留/profile 解码(纯函数)
  lib/h5Token.ts        # H5 token 解密+校验(纯函数,AES-CBC/ECB)
  lib/h5.ts             # 一次性 code 签发/消费
  lib/syncEngine.ts     # 同步引擎(自动/手动共用,状态对账+审计+互斥锁)
  lib/ssoState.ts       # 回调地址状态
backend/test/           # node:test 单测(26 例)
web/src/modules/
  sinosure-settings/    # 配置页(五区)
  sinosure-h5-entry/    # APP H5 登录入口页
config/plugin.yaml      # 团队级 + account 能力 + settings/about:blank 模块 + 6 API + 6 实体
```
