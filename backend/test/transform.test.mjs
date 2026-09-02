import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROOT_DEPT_ID,
  buildDepartments,
  buildUsers,
  fabricateEmail,
  isValidEmail,
  normalizeProfile,
  safeDecode,
} from '../src/lib/transform.ts'

test('safeDecode 解码 URL 编码中文并容忍非法序列', () => {
  assert.equal(safeDecode('%E9%AD%8F%E7%94%9F%E8%BE%89'), '魏生辉')
  assert.equal(safeDecode('开发四处'), '开发四处')
  assert.equal(safeDecode('100%'), '100%')
  assert.equal(safeDecode(undefined), '')
})

test('fabricateEmail 拼接规则:userid 小写 + 后缀', () => {
  assert.equal(fabricateEmail('ZhangS', '@sinosure.cn'), 'zhangs@sinosure.cn')
  assert.equal(fabricateEmail('zhangs', 'sinosure.cn'), 'zhangs@sinosure.cn')
})

test('isValidEmail', () => {
  assert.equal(isValidEmail('zhangs@sinosure.cn'), true)
  assert.equal(isValidEmail('zhangs'), false)
  assert.equal(isValidEmail('a b@c.d'), false)
})

test('buildDepartments 组装 根部门-部门-处室 三层', () => {
  const result = buildDepartments(
    [
      {
        deptserialno: null,
        deptid: '8168',
        groupname: '董事会办公室',
        deptorder: 70,
        division: [{ sectionname: '提案处室', sectionid: '816802', queryorder: 1 }],
      },
      { deptid: '3000', groupname: '山东分公司', division: [] },
    ],
    '中国出口信用保险公司',
  )

  assert.equal(result.departments.length, 4)
  assert.deepEqual(result.departments[0], {
    third_party_id: '-1',
    name: '中国出口信用保险公司',
    parent_id: '',
    next_id: '',
  })
  assert.deepEqual(result.departments[1], {
    third_party_id: '8168',
    name: '董事会办公室',
    parent_id: '-1',
    next_id: '',
  })
  assert.deepEqual(result.departments[2], {
    third_party_id: '816802',
    name: '提案处室',
    parent_id: '8168',
    next_id: '',
  })
  assert.ok(result.knownDeptIds.has('816802'))
  assert.ok(result.knownDeptIds.has(ROOT_DEPT_ID))
  assert.equal(result.skipped.length, 0)
})

test('buildDepartments 跳过缺失 id 与重复 id', () => {
  const result = buildDepartments(
    [
      { deptid: '', groupname: '无名部门' },
      { deptid: '10', groupname: 'A' },
      { deptid: '10', groupname: 'B', division: [{ sectionid: '11', sectionname: 'X' }] },
      { deptid: '-1', groupname: '冲突根' },
      { deptid: '20', groupname: 'C', division: [{ sectionid: '11', sectionname: '重复处室' }] },
    ],
    '根',
  )
  // 根 + 10 + 11(来自 20 的处室)+ 20 = 4;重复部门 10 整条跳过,其下处室不进入
  assert.equal(result.departments.length, 4)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].reason, '缺少 deptid')
  const names = result.departments.map((d) => d.name)
  assert.deepEqual(names, ['根', 'A', 'C', '重复处室'])
  assert.ok(result.warnings.some((w) => w.includes('重复')))
  assert.ok(result.warnings.some((w) => w.includes('冲突')))
})

test('buildUsers 常规映射:userid/姓名/邮箱/职位/处室', () => {
  const departments = buildDepartments(
    [
      {
        deptid: '3000',
        groupname: '山东分公司',
        division: [{ sectionid: '300021', sectionname: '威海营业部' }],
      },
    ],
    '根',
  )
  const result = buildUsers(
    [
      {
        hrid: 'L102521',
        name: '张三',
        email: 'zhangs@sinosure.cn',
        userid: 'zhangs',
        sortName: '普通员工',
        departmentNo: '3000',
        divisionNo: '300021',
      },
    ],
    { emailSuffix: '@sinosure.cn', excludeEmployeeTypes: [], knownDeptIds: departments.knownDeptIds, company: '中国信保' },
  )

  assert.equal(result.users.length, 1)
  assert.deepEqual(result.users[0], {
    third_party_id: 'zhangs',
    name: '张三',
    email: 'zhangs@sinosure.cn',
    title: '普通员工',
    department_ids: ['300021'],
    company: '中国信保',
  })
})

test('buildUsers 无邮箱拼接、处室不在树中回退部门、缺 userid 跳过、类别过滤、重复保留首条', () => {
  const departments = buildDepartments([{ deptid: '3000', groupname: '山东分公司', division: [] }], '根')
  const options = {
    emailSuffix: '@sinosure.cn',
    excludeEmployeeTypes: ['25', '26'],
    knownDeptIds: departments.knownDeptIds,
    company: '中国信保',
  }
  const result = buildUsers(
    [
      // 无邮箱 -> 拼接;处室 999999 不在树中 -> 回退部门 3000
      { userid: 'weish', name: '魏生辉', departmentNo: '3000', divisionNo: '999999' },
      // 无处室无部门 -> 根部门
      { userid: 'noman', name: '无部门' },
      // 类别 25 实习 -> 不同步
      { userid: 'intern', name: '实习生', employeeType: '25' },
      // 缺 userid -> 跳过
      { name: '幽灵', hrid: 'X1' },
      // 重复 userid -> 保留首条
      { userid: 'weish', name: '魏生辉2' },
      // 邮箱格式异常 -> 拼接并告警
      { userid: 'badmail', name: '坏邮箱', email: 'not-an-email' },
    ],
    options,
  )

  assert.equal(result.users.length, 3)
  assert.equal(result.users[0].third_party_id, 'weish')
  assert.equal(result.users[0].email, 'weish@sinosure.cn')
  assert.deepEqual(result.users[0].department_ids, ['3000'])
  assert.deepEqual(result.users[1].department_ids, [ROOT_DEPT_ID])
  assert.equal(result.users[2].email, 'badmail@sinosure.cn')

  const skippedIds = result.skipped.map((s) => s.id)
  assert.ok(skippedIds.includes('intern'))
  assert.ok(skippedIds.includes('幽灵'))
  assert.ok(result.skipped.some((s) => s.reason.includes('员工类别')))
  assert.ok(result.warnings.some((w) => w.includes('回退到所属部门')))
  assert.ok(result.warnings.some((w) => w.includes('格式异常')))
  assert.ok(result.warnings.some((w) => w.includes('重复')))
})

test('normalizeProfile 解码中文、校验标识与状态', () => {
  const ok = normalizeProfile({
    service: 'http://APP1/demo/WelcomePage',
    attributes: {
      deptName: '%E4%BF%A1%E6%81%AF%E7%A7%91%E6%8A%80%E9%83%A8',
      deptId: '8210',
      userName: '%E9%AD%8F%E7%94%9F%E8%BE%89',
      userId: 'weish',
      state: '1',
    },
    id: 'weish',
    client_id: 'x',
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.userId, 'weish')
  assert.equal(ok.name, '魏生辉')
  assert.equal(ok.deptName, '信息科技部')

  const noAttrs = normalizeProfile({ id: '', attributes: {} })
  assert.equal(noAttrs.ok, false)
  assert.ok(noAttrs.reason.includes('无 OA 账号'))

  const invalid = normalizeProfile({ id: 'x', attributes: { state: '0' } })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.reason.includes('state=0'))
})
