/**
 * v2 -> v3 升级验证：先按 v2 结构灌入「旧数据」（无判读记录），
 * 再以当前应用结构打开同一库，断言：
 *  1. 升级成功，interpretations 表出现；
 *  2. 每条样带补出一条 source=initial 的判读记录；
 *  3. 初始判读覆盖率 == 外业覆盖率、判读等级 == 外业总体等级。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import assert from 'node:assert'
import { db, DB_VERSION } from '../src/utils/db'
import { coralCoveragePct, bleachGrade, bleachIndex } from '../src/utils/bleach'

// 1) 用独立 Dexie 实例建一个 v2 旧库
const old = new Dexie('gbcoralbelt')
old.version(2).stores({
  reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
  sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
  belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
  corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
  fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
})

const now = Date.now()
await old.reefs.bulkPut([{ id: 'r1', name: '旧礁区', protectStatus: '核心区', createdAt: now, updatedAt: now }])
await old.sites.bulkPut([{ id: 's1', reefId: 'r1', no: 'S-01', lat: 1, lng: 2, depthM: 5, substrate: '珊瑚礁石', createdAt: now, updatedAt: now }])
await old.belts.bulkPut([
  { id: 'b1', siteId: 's1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '林之遥', createdAt: now, updatedAt: now },
  { id: 'b2', siteId: 's1', no: 'T-02', lengthM: 25, orientation: '东', surveyDate: '2026-09-01', observer: '林之遥', createdAt: now, updatedAt: now }
])
// b1: 2900cm/50m=58%，轻；b2: 830cm/25m=33.2%，中
await old.corals.bulkPut([
  { id: 'c1', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '', createdAt: now, updatedAt: now },
  { id: 'c2', beltId: 'b1', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '轻', remark: '', createdAt: now, updatedAt: now },
  { id: 'c3', beltId: 'b1', genus: '软珊瑚属', form: '软珊瑚', coverCm: 920, bleachLevel: '轻', remark: '', createdAt: now, updatedAt: now },
  { id: 'c4', beltId: 'b2', genus: '蜂巢珊瑚属', form: '块状', coverCm: 830, bleachLevel: '中', remark: '', createdAt: now, updatedAt: now }
])
await old.close()

// 2) 用当前应用结构打开 -> 触发 v3 upgrade
await db.open()
assert.strictEqual(DB_VERSION, 3, 'DB_VERSION 应为 3')
const ints = await db.interpretations.toArray()
assert.strictEqual(ints.length, 2, '应为两条样带各补一条初始判读')

for (const beltId of ['b1', 'b2']) {
  const belt = await db.belts.get(beltId)
  const corals = await db.corals.where('beltId').equals(beltId).toArray()
  const expectedPct = coralCoveragePct(corals.reduce((s, c) => s + c.coverCm, 0), belt.lengthM)
  const expectedGrade = bleachGrade(bleachIndex(corals))
  const int = ints.find((i) => i.beltId === beltId)
  assert.ok(int, `${beltId} 缺少判读记录`)
  assert.strictEqual(int.source, 'initial', `${beltId} 应标成初始值`)
  assert.strictEqual(int.revised, false)
  assert.strictEqual(int.coveragePct, expectedPct, `${beltId} 初始覆盖率应等于外业`)
  assert.strictEqual(int.bleachLevel, expectedGrade, `${beltId} 初始等级应等于外业总体等级`)
  assert.strictEqual(int.reviewedDate, belt.surveyDate)
}

// 3) 对账函数：升级补录的初始值按「待判读」处理（判读室尚未正式判）
const { reconcileCoverage } = await import('../src/types/interpretation')
const intB1 = ints.find((i) => i.beltId === 'b1')
assert.strictEqual(reconcileCoverage({ interpretation: intB1, fieldCoveragePct: intB1.coveragePct }), 'pending')
// 正式判读（source=judged）：差 10 点（含）不算挂起，>10 才挂起
assert.strictEqual(reconcileCoverage({ interpretation: { coveragePct: 48, revised: false, source: 'judged' }, fieldCoveragePct: 58 }), 'matched')
assert.strictEqual(reconcileCoverage({ interpretation: { coveragePct: 47.99, revised: false, source: 'judged' }, fieldCoveragePct: 58 }), 'held')
// 未判读 -> pending；重判 -> released（即使差仍超阈值）
assert.strictEqual(reconcileCoverage({ interpretation: null, fieldCoveragePct: 58 }), 'pending')
assert.strictEqual(reconcileCoverage({ interpretation: { coveragePct: 46, revised: true, source: 'judged' }, fieldCoveragePct: 58 }), 'released')

console.log('v2->v3 upgrade + reconcile 断言全部通过')
db.close()
