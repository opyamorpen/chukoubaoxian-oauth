/**
 * 同步引擎:DoPullData(自动,每 10 分钟)与手动同步共用。
 * 职责:拉取 OA 两接口 -> buildSyncPayload -> 持久化部门/邮箱状态 -> 写审计。
 * 任一接口失败即整体失败,不变更任何状态(保留上一次成功结果)。
 */
import { storage } from '@ones-op/sdk/backend'
import { Logger } from '@ones-op/node-logger'
import { fetchOaDepartments, fetchOaEmployees } from './oaClient'
import {
  buildSyncPayload,
  type DeptStateEntry,
  type EmailStateEntry,
} from './transform'
import type { SinosureConfig } from './config'

const AUDIT_ENTITY = 'sync_audit'
const AUDIT_LATEST_KEY = 'latest'
const LOCK_ENTITY = 'sso_state'
const LOCK_KEY = 'sync_lock'
const LOCK_TTL_MS = 3 * 60 * 1000

/** 游标分页读取实体全部记录(getMany 的 limit 在部分版本被硬限 10 条,必须走 query 构建器) */
async function qAll(entityName: string): Promise<Array<{ key: string; record: Record<string, unknown> }>> {
  const entity: any = storage.entity(entityName)
  const all: Array<{ key: string; record: Record<string, unknown> }> = []
  let cursor: string | null = null
  let safety = 0
  while (safety < 500) {
    const query = entity.query().limit(200)
    if (cursor) {
      query.cursor(cursor)
    }
    const result = await query.getMany()
    const data = result?.data ?? result ?? []
    if (!Array.isArray(data) || data.length === 0) {
      break
    }
    for (const item of data) {
      const entry = item ?? {}
      const key = entry.key ?? entry.id ?? entry.Key
      if (typeof key === 'string' && key !== '') {
        all.push({ key, record: (entry.record ?? entry.attributes ?? entry) as Record<string, unknown> })
      }
    }
    const pageInfo = result?.page_info
    if (pageInfo?.has_more && pageInfo?.end_cursor) {
      cursor = pageInfo.end_cursor
      safety++
    } else {
      break
    }
  }
  return all
}

export async function loadDeptState(): Promise<Map<string, DeptStateEntry>> {
  const map = new Map<string, DeptStateEntry>()
  try {
    for (const { key, record } of await qAll('dept_state')) {
      const name = typeof record.name === 'string' ? record.name : ''
      const parentId = typeof record.parent_id === 'string' ? record.parent_id : ''
      const status = record.status === 'preserved' ? 'preserved' : 'active'
      map.set(key, { name, parentId, status })
    }
  } catch (error) {
    Logger.warning('[sinosure] 读取部门状态失败(按空处理):', error)
  }
  return map
}

export async function loadEmailState(): Promise<Map<string, EmailStateEntry>> {
  const map = new Map<string, EmailStateEntry>()
  try {
    for (const { key, record } of await qAll('user_email_state')) {
      const email = typeof record.email === 'string' ? record.email : ''
      if (email) {
        map.set(key, { email, isVirtual: record.is_virtual !== false })
      }
    }
  } catch (error) {
    Logger.warning('[sinosure] 读取邮箱状态失败(按空处理):', error)
  }
  return map
}

/** 部门状态全量对账:变更/新增 upsert,本轮已不存在且未被保留的删除 */
async function persistDeptState(next: Map<string, DeptStateEntry>, previous: Map<string, DeptStateEntry>): Promise<void> {
  const entity = storage.entity('dept_state')
  for (const [id, entry] of next) {
    const old = previous.get(id)
    if (!old || old.name !== entry.name || old.parentId !== entry.parentId || old.status !== entry.status) {
      await entity.set(id, { name: entry.name, parent_id: entry.parentId, status: entry.status })
    }
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) {
      await entity.delete(id)
    }
  }
}

async function persistEmailChanges(changes: Map<string, EmailStateEntry>): Promise<void> {
  if (changes.size === 0) {
    return
  }
  const entity = storage.entity('user_email_state')
  for (const [userid, entry] of changes) {
    await entity.set(userid, { email: entry.email, is_virtual: entry.isVirtual })
  }
}

export interface SyncReport {
  ok: boolean
  error?: string
  trigger: string
  deptCount: number
  userCount: number
  skippedCount: number
  preservedDeptCount: number
  warnings: string[]
  departments?: Array<{ third_party_id: string; name: string; parent_id: string; next_id: string }>
  users?: Array<{
    third_party_id: string
    name: string
    email: string
    title: string
    department_ids: string[]
    company: string
  }>
}

async function writeAudit(report: SyncReport): Promise<void> {
  const pulledAt = new Date().toISOString()
  const attributes = {
    pulled_at: pulledAt,
    dept_count: report.deptCount,
    user_count: report.userCount,
    skipped_count: report.skippedCount,
    preserved_dept_count: report.preservedDeptCount,
    trigger: report.trigger,
    error: report.error ?? '',
  }
  try {
    await storage.entity(AUDIT_ENTITY).set(AUDIT_LATEST_KEY, attributes)
    await storage.entity(AUDIT_ENTITY).set(pulledAt, attributes)
  } catch (error) {
    Logger.warning('[sinosure] 写入同步审计失败:', error)
  }
}

/**
 * 执行一次同步。withPayload=true 时(DoPullData)返回组装结果供 ONES 落库;
 * 任一 OA 接口失败时整体失败且不写任何状态,ONES 保留上一次成功结果。
 */
export async function runSync(config: SinosureConfig, trigger: 'auto' | 'manual', withPayload: boolean): Promise<SyncReport> {
  const base: SyncReport = {
    ok: false,
    trigger,
    deptCount: 0,
    userCount: 0,
    skippedCount: 0,
    preservedDeptCount: 0,
    warnings: [],
  }
  let employees: unknown[]
  let departments: unknown[]
  try {
    ;[employees, departments] = await Promise.all([
      fetchOaEmployees(config.oa),
      fetchOaDepartments(config.oa),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const report = { ...base, error: message }
    await writeAudit(report)
    return report
  }

  const [previousDeptState, lastEmailState] = await Promise.all([loadDeptState(), loadEmailState()])
  const payload = buildSyncPayload(departments, employees, {
    rootDeptName: config.account.rootDeptName,
    emailSuffix: config.account.emailSuffix,
    excludeEmployeeTypes: config.sync.excludeEmployeeTypes,
    company: config.account.company,
    previousDeptState,
    lastEmailState,
  })

  try {
    await persistEmailChanges(payload.emailStateChanges)
    await persistDeptState(payload.deptState, previousDeptState)
  } catch (error) {
    const message = `状态持久化失败: ${error instanceof Error ? error.message : String(error)}`
    const report = { ...base, error: message }
    await writeAudit(report)
    return report
  }

  if (payload.warnings.length > 0) {
    Logger.warning('[sinosure] 同步告警:', payload.warnings.slice(0, 20).join('; '))
  }

  const report: SyncReport = {
    ok: true,
    trigger,
    deptCount: payload.departments.length,
    userCount: payload.users.length,
    skippedCount: payload.skipped.length,
    preservedDeptCount: payload.preservedDeptCount,
    warnings: payload.warnings,
  }
  if (withPayload) {
    report.departments = payload.departments
    report.users = payload.users
  }
  await writeAudit(report)
  Logger.info(
    `[sinosure] 同步完成(${trigger}): 部门 ${report.deptCount}(含根部门), 用户 ${report.userCount}, 跳过 ${report.skippedCount}, 保留消失部门 ${report.preservedDeptCount}`,
  )
  return report
}

export async function readLatestAudit(): Promise<Record<string, unknown> | null> {
  try {
    const record = (await storage.entity(AUDIT_ENTITY).get(AUDIT_LATEST_KEY)) as
      | Record<string, unknown>
      | undefined
    return record ?? null
  } catch {
    return null
  }
}

/** 手动同步互斥锁:锁定中(3 分钟内)拒绝重复启动 */
export async function acquireSyncLock(): Promise<boolean> {
  const entity = storage.entity(LOCK_ENTITY)
  const existing = (await entity.get(LOCK_KEY)) as { value?: string } | undefined
  if (existing?.value) {
    const lockedAt = Date.parse(existing.value)
    if (Number.isFinite(lockedAt) && Date.now() - lockedAt < LOCK_TTL_MS) {
      return false
    }
  }
  await entity.set(LOCK_KEY, { value: new Date().toISOString(), updated_at: new Date().toISOString() })
  return true
}

export async function releaseSyncLock(): Promise<void> {
  try {
    await storage.entity(LOCK_ENTITY).delete(LOCK_KEY)
  } catch {
    // 锁记录不存在视为已释放
  }
}
