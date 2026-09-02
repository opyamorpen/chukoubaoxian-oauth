/**
 * OA 数据 -> ONES account 能力数据结构的纯函数转换层。
 * 不依赖任何 SDK,可独立做单元测试。
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

export interface BuildDepartmentsResult {
  departments: DepartmentInfo[]
  knownDeptIds: Set<string>
  skipped: SkippedRecord[]
  warnings: string[]
}

export interface BuildUsersOptions {
  emailSuffix: string
  excludeEmployeeTypes: string[]
  knownDeptIds: Set<string>
  company: string
}

export interface BuildUsersResult {
  users: UserInfo[]
  skipped: SkippedRecord[]
  warnings: string[]
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

/** 无邮箱用户按 8/31 会议结论拼接:userid + 固定后缀 */
export function fabricateEmail(userid: string, emailSuffix: string): string {
  const suffix = emailSuffix.startsWith('@') ? emailSuffix : `@${emailSuffix}`
  return `${userid.toLowerCase()}${suffix}`
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

/**
 * OA 人员接口返回 -> ONES 用户列表。
 * - third_party_id = userid(8/31 会议确认的唯一标识,与单点系统一致)
 * - 无邮箱时用 userid + 后缀拼接(ONES 建号必须有邮箱)
 * - 部门优先挂处室(divisionNo),处室不在部门树中时回退部门(departmentNo),再回退根部门
 * - 一人双账号不合并(客户已确认接受两个账号)
 */
export function buildUsers(oaEmployees: unknown[], options: BuildUsersOptions): BuildUsersResult {
  const users: UserInfo[] = []
  const skipped: SkippedRecord[] = []
  const warnings: string[] = []

  if (!Array.isArray(oaEmployees)) {
    return { users, skipped, warnings: ['人员接口返回非数组'] }
  }

  const excludeTypes = new Set(
    (options.excludeEmployeeTypes || []).map((type) => toTrimmedString(type)).filter(Boolean),
  )

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

    const rawEmail = toTrimmedString(employee.email)
    const email = isValidEmail(rawEmail) ? rawEmail : fabricateEmail(userid, options.emailSuffix)
    if (rawEmail && !isValidEmail(rawEmail)) {
      warnings.push(`userid ${userid} 的邮箱 "${rawEmail}" 格式异常,已改用拼接邮箱 ${email}`)
    }

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

  return { users, skipped, warnings }
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
 * 单点系统 profile 接口返回 -> 登录用户信息。
 * 文档明确:用户在 OA 中不存在或 RBAC 状态无效时 attributes 缺失,
 * 此时仅有 oauth 校验意义,ONES 侧应拒绝其以同步账号登录。
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
    return { ...base, ok: false, reason: '单点系统未返回用户标识(该用户可能无 OA 账号,如仅有 AD 账号的外包人员)' }
  }
  if (base.state === '0') {
    return { ...base, ok: false, reason: '用户在 RBAC 系统中状态无效(state=0)' }
  }
  return { ...base, ok: true }
}
