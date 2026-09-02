/**
 * OA 数据 -> ONES account 能力数据结构的纯函数转换层。
 * 不依赖任何 SDK,可独立做单元测试。
 *
 * 承载的方案规则:
 * - 邮箱保留:OA 返回合法邮箱时首次使用原邮箱;首次以虚拟邮箱(userid+后缀)创建后,
 *   OA 后续补齐真实邮箱也不自动覆盖
 * - 邮箱冲突:同批次内两个 userid 解析出相同邮箱时,后者跳过并记录原因
 * - 部门保留:OA 中消失的部门,若仍被本次返回的有效人员引用,则继续保留在返回树中
 *   (DoPullData 契约仅含 id/name/parent,无法表达"停用"标记,保留策略见 README)
 */

export interface DepartmentInfo {
  third_party_id: string
  name: string
  parent_id: string
  next_id: string
}

export interface UserInfo {
  third_party_id: string
  name: string
  email: string
  title: string
  department_ids: string[]
  company: string
}

export interface SkippedRecord {
  id: string
  reason: string
}

export interface EmailStateEntry {
  email: string
  isVirtual: boolean
}

export interface DeptStateEntry {
  name: string
  parentId: string
  status: 'active' | 'preserved'
}

/** ONES account 能力约定:根部门 third_party_id 固定为 -1 */
export const ROOT_DEPT_ID = '-1'

/**
 * 解码接口文档中 URL 编码的中文(如 userName=%E9%AD%8F%E7%94%9F%E8%BE%89)。
 * 解码失败(非法百分号序列)或非字符串时原样返回。
 */
export function safeDecode(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    return typeof value === 'string' ? value : ''
  }
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

/** 邮箱仅要求形如 a@b,ONES 建号必须有邮箱,无邮箱时由调用方拼接 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** 无邮箱用户按确认方案拼接:userid + 固定后缀 */
export function fabricateEmail(userid: string, emailSuffix: string): string {
  const suffix = emailSuffix.startsWith('@') ? emailSuffix : `@${emailSuffix}`
  return `${userid.toLowerCase()}${suffix}`
}

export interface BuildDepartmentsResult {
  departments: DepartmentInfo[]
  knownDeptIds: Set<string>
  skipped: SkippedRecord[]
  warnings: string[]
}

/**
 * OA 部门接口返回 -> ONES 部门树。
 * 结构:根部门(-1) -> 部门(deptid, 父=-1) -> 处室(sectionid, 父=deptid)。
 * 字段缺失、id 冲突的记录跳过并记录原因,不中断整体同步。
 */
export function buildDepartments(oaDepartments: unknown[], rootDeptName: string): BuildDepartmentsResult {
  const departments: DepartmentInfo[] = []
  const knownDeptIds = new Set<string>()
  const skipped: SkippedRecord[] = []
  const warnings: string[] = []

  departments.push({
    third_party_id: ROOT_DEPT_ID,
    name: rootDeptName || '中国出口信用保险公司',
    parent_id: '',
    next_id: '',
  })
  knownDeptIds.add(ROOT_DEPT_ID)

  if (!Array.isArray(oaDepartments)) {
    return { departments, knownDeptIds, skipped, warnings: ['部门接口返回非数组'] }
  }

  for (const raw of oaDepartments) {
    const dept = (raw ?? {}) as Record<string, unknown>
    const deptId = toTrimmedString(dept.deptid)
    if (!deptId) {
      skipped.push({ id: toTrimmedString(dept.groupname), reason: '缺少 deptid' })
      continue
    }
    if (deptId === ROOT_DEPT_ID) {
      warnings.push(`部门 ${deptId}(${toTrimmedString(dept.groupname)}) 与根部门 ID 冲突,已跳过`)
      continue
    }
    if (knownDeptIds.has(deptId)) {
      warnings.push(`部门 ${deptId}(${toTrimmedString(dept.groupname)}) 重复,仅保留第一条`)
      continue
    }

    departments.push({
      third_party_id: deptId,
      name: toTrimmedString(dept.groupname) || deptId,
      parent_id: ROOT_DEPT_ID,
      next_id: '',
    })
    knownDeptIds.add(deptId)

    const divisions = Array.isArray(dept.division) ? dept.division : []
    for (const rawDivision of divisions) {
      const division = (rawDivision ?? {}) as Record<string, unknown>
      const sectionId = toTrimmedString(division.sectionid)
      if (!sectionId) {
        skipped.push({
          id: `${deptId}/${toTrimmedString(division.sectionname)}`,
          reason: '缺少 sectionid',
        })
        continue
      }
      if (knownDeptIds.has(sectionId)) {
        warnings.push(`处室 ${sectionId}(${toTrimmedString(division.sectionname)}) 重复,仅保留第一条`)
        continue
      }
      departments.push({
        third_party_id: sectionId,
        name: toTrimmedString(division.sectionname) || sectionId,
        parent_id: deptId,
        next_id: '',
      })
      knownDeptIds.add(sectionId)
    }
  }

  return { departments, knownDeptIds, skipped, warnings }
}

export interface BuildUsersOptions {
  emailSuffix: string
  excludeEmployeeTypes: string[]
  knownDeptIds: Set<string>
  company: string
  /** 上一轮持久化的邮箱状态(邮箱保留规则的依据) */
  lastEmailState?: Map<string, EmailStateEntry>
}

export interface BuildUsersResult {
  users: UserInfo[]
  skipped: SkippedRecord[]
  warnings: string[]
  /** 本批次成功处理用户的邮箱状态(全量) */
  emailState: Map<string, EmailStateEntry>
}

/**
 * OA 人员接口返回 -> ONES 用户列表。
 * - third_party_id = userid(唯一标识,单点认证与通讯录口径一致)
 * - 无邮箱时用 userid + 后缀拼接;虚拟邮箱粘性:创建后不因 OA 补齐真实邮箱而覆盖
 * - 同批次邮箱冲突后者跳过并记录原因
 * - 部门优先挂处室(divisionNo),不在已知树中时回退部门(departmentNo),再回退根部门
 * - 一人双账号不合并(方案确认:同一自然人多个 userid 分别对应不同 ONES 账号)
 */
export function buildUsers(oaEmployees: unknown[], options: BuildUsersOptions): BuildUsersResult {
  const users: UserInfo[] = []
  const skipped: SkippedRecord[] = []
  const warnings: string[] = []
  const emailState = new Map<string, EmailStateEntry>()
  const usedEmails = new Set<string>()

  if (!Array.isArray(oaEmployees)) {
    return { users, skipped, warnings: ['人员接口返回非数组'], emailState }
  }

  const excludeTypes = new Set(
    (options.excludeEmployeeTypes || []).map((type) => toTrimmedString(type)).filter(Boolean),
  )
  const lastEmailState = options.lastEmailState ?? new Map<string, EmailStateEntry>()

  const seenUserids = new Set<string>()
  for (const raw of oaEmployees) {
    const employee = (raw ?? {}) as Record<string, unknown>
    const userid = toTrimmedString(employee.userid)
    if (!userid) {
      skipped.push({
        id: toTrimmedString(employee.name) || toTrimmedString(employee.hrid),
        reason: '缺少 userid',
      })
      continue
    }

    const employeeType = toTrimmedString(employee.employeeType)
    if (excludeTypes.has(employeeType)) {
      skipped.push({ id: userid, reason: `员工类别 ${employeeType} 被配置为不同步` })
      continue
    }

    if (seenUserids.has(userid)) {
      warnings.push(`userid ${userid} 重复,仅保留第一条`)
      continue
    }
    seenUserids.add(userid)

    // ---- 邮箱决策(保留规则) ----
    const existing = lastEmailState.get(userid)
    const rawEmail = toTrimmedString(employee.email)
    const hasValidRawEmail = isValidEmail(rawEmail)
    let email: string
    let isVirtual: boolean
    if (existing?.isVirtual) {
      // 首次以虚拟邮箱创建:即使 OA 补齐真实邮箱也不覆盖
      email = existing.email
      isVirtual = true
      if (hasValidRawEmail && rawEmail.toLowerCase() !== existing.email.toLowerCase()) {
        warnings.push(`userid ${userid} 的 OA 已补齐真实邮箱,按保留规则继续使用虚拟邮箱`)
      }
    } else if (hasValidRawEmail) {
      email = rawEmail
      isVirtual = false
    } else {
      email = fabricateEmail(userid, options.emailSuffix)
      isVirtual = true
      if (rawEmail) {
        warnings.push(`userid ${userid} 的邮箱 "${rawEmail}" 格式异常,已改用拼接邮箱`)
      }
    }

    if (usedEmails.has(email.toLowerCase())) {
      skipped.push({ id: userid, reason: `解析邮箱 ${email} 与其他人员冲突,跳过本条` })
      continue
    }
    usedEmails.add(email.toLowerCase())
    emailState.set(userid, { email, isVirtual })

    // ---- 部门归属 ----
    const divisionNo = toTrimmedString(employee.divisionNo)
    const departmentNo = toTrimmedString(employee.departmentNo)
    let departmentId = ROOT_DEPT_ID
    if (divisionNo && options.knownDeptIds.has(divisionNo)) {
      departmentId = divisionNo
    } else if (divisionNo) {
      warnings.push(`userid ${userid} 的处室 ${divisionNo} 不在部门树中,回退到所属部门`)
    }
    if (departmentId === ROOT_DEPT_ID && departmentNo && options.knownDeptIds.has(departmentNo)) {
      departmentId = departmentNo
    }

    users.push({
      third_party_id: userid,
      name: toTrimmedString(employee.name) || userid,
      email,
      title: toTrimmedString(employee.sortName),
      department_ids: [departmentId],
      company: options.company || '',
    })
  }

  return { users, skipped, warnings, emailState }
}

export interface BuildSyncPayloadOptions {
  rootDeptName: string
  emailSuffix: string
  excludeEmployeeTypes: string[]
  company: string
  /** 上一轮持久化的部门状态(消失部门保留的依据) */
  previousDeptState?: Map<string, DeptStateEntry>
  lastEmailState?: Map<string, EmailStateEntry>
}

export interface SyncPayloadResult {
  departments: DepartmentInfo[]
  users: UserInfo[]
  skipped: SkippedRecord[]
  warnings: string[]
  /** 本轮结束后的部门状态全量(active + 被引用的 preserved) */
  deptState: Map<string, DeptStateEntry>
  /** 相对上一轮新增/变更的邮箱状态(增量写回) */
  emailStateChanges: Map<string, EmailStateEntry>
  preservedDeptCount: number
}

/**
 * 同步总装:部门树(含消失部门保留)+ 用户列表(含邮箱保留规则)。
 * 消失部门的保留条件:仍被本批次至少一名有效人员引用。
 */
export function buildSyncPayload(
  oaDepartments: unknown[],
  oaEmployees: unknown[],
  options: BuildSyncPayloadOptions,
): SyncPayloadResult {
  const current = buildDepartments(oaDepartments, options.rootDeptName)
  const previousDeptState = options.previousDeptState ?? new Map<string, DeptStateEntry>()

  const preservedCandidates = new Map<string, DeptStateEntry>()
  for (const [id, entry] of previousDeptState) {
    if (!current.knownDeptIds.has(id)) {
      preservedCandidates.set(id, entry)
    }
  }

  const mergedKnownIds = new Set<string>(current.knownDeptIds)
  for (const id of preservedCandidates.keys()) {
    mergedKnownIds.add(id)
  }

  const userResult = buildUsers(oaEmployees, {
    emailSuffix: options.emailSuffix,
    excludeEmployeeTypes: options.excludeEmployeeTypes,
    knownDeptIds: mergedKnownIds,
    company: options.company,
    lastEmailState: options.lastEmailState,
  })

  // 被有效人员引用的消失部门才保留
  const referencedPreservedIds = new Set<string>()
  for (const user of userResult.users) {
    for (const deptId of user.department_ids) {
      if (preservedCandidates.has(deptId)) {
        referencedPreservedIds.add(deptId)
      }
    }
  }

  const departments = [...current.departments]
  for (const id of referencedPreservedIds) {
    const entry = preservedCandidates.get(id)!
    departments.push({
      third_party_id: id,
      name: entry.name,
      parent_id: entry.parentId,
      next_id: '',
    })
  }

  const deptState = new Map<string, DeptStateEntry>()
  for (const dept of departments) {
    deptState.set(dept.third_party_id, {
      name: dept.name,
      parentId: dept.parent_id,
      status: referencedPreservedIds.has(dept.third_party_id) ? 'preserved' : 'active',
    })
  }

  const lastEmailState = options.lastEmailState ?? new Map<string, EmailStateEntry>()
  const emailStateChanges = new Map<string, EmailStateEntry>()
  for (const [userid, entry] of userResult.emailState) {
    const previous = lastEmailState.get(userid)
    if (!previous || previous.email !== entry.email || previous.isVirtual !== entry.isVirtual) {
      emailStateChanges.set(userid, entry)
    }
  }

  const warnings = [...current.warnings, ...userResult.warnings]
  if (referencedPreservedIds.size > 0) {
    warnings.push(`OA 已消失但仍被有效人员引用、继续保留的部门: ${[...referencedPreservedIds].join(', ')}`)
  }

  return {
    departments,
    users: userResult.users,
    skipped: [...current.skipped, ...userResult.skipped],
    warnings,
    deptState,
    emailStateChanges,
    preservedDeptCount: referencedPreservedIds.size,
  }
}

export interface NormalizedProfile {
  ok: boolean
  reason?: string
  userId: string
  name: string
  deptId: string
  deptName: string
  secDeptId: string
  secDeptName: string
  employeeId: string
  state: string
}

/**
 * 统一认证平台 profile 接口返回 -> 登录用户信息。
 * 文档明确:用户在 OA 中不存在或 RBAC 状态无效时 attributes 缺失,
 * 此时仅有 oauth 校验意义,ONES 侧应拒绝其登录。
 */
export function normalizeProfile(raw: unknown): NormalizedProfile {
  const profile = (raw ?? {}) as Record<string, any>
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>

  const userId =
    toTrimmedString(profile.id) || toTrimmedString(profile.userId) || toTrimmedString(attributes.userId)

  const base: NormalizedProfile = {
    ok: false,
    userId,
    name: safeDecode(attributes.userName) || userId,
    deptId: toTrimmedString(attributes.deptId),
    deptName: safeDecode(attributes.deptName),
    secDeptId: toTrimmedString(attributes.secDeptId),
    secDeptName: safeDecode(attributes.secDeptName),
    employeeId: toTrimmedString(attributes.employeeId),
    state: toTrimmedString(attributes.state),
  }

  if (!userId) {
    return {
      ...base,
      ok: false,
      reason: '统一认证平台未返回用户标识(该用户可能无 OA 账号,如仅有 AD 账号的外包人员)',
    }
  }
  if (base.state === '0') {
    return { ...base, ok: false, reason: '用户在 RBAC 系统中状态无效(state=0)' }
  }
  return { ...base, ok: true }
}
