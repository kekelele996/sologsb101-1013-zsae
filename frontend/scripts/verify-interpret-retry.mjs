/**
 * 判读落账重试验证：
 *  1. 首次写失败、第二次成功：putInterpretationWithRetry 自动重试落账；
 *  2. 全部尝试失败：函数 reject，且外业 corals 数据原样保留（两侧各存各的）；
 *  3. 重试仅作用于 interpretations 表，不触碰外业表。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db, putInterpretationWithRetry } from '../src/utils/db'

await db.open()
await db.corals.put({
  id: 'c-field-1',
  beltId: 'b1',
  genus: '鹿角珊瑚属',
  form: '枝状',
  coverCm: 1000,
  bleachLevel: '无',
  remark: '外业记录，不应被判读写失败影响',
  createdAt: 1,
  updatedAt: 1
})

const baseRow = {
  beltId: 'b1',
  coveragePct: 58,
  bleachLevel: '无',
  reviewer: '苏映雪',
  reviewedDate: '2026-10-05',
  remark: '',
  source: 'judged',
  revised: false,
  createdAt: 2,
  updatedAt: 2
}
const now = Date.now()

// 1) 首次失败、重试成功
const originalPut = db.interpretations.put.bind(db.interpretations)
let attempts = 0
db.interpretations.put = async (...args) => {
  attempts += 1
  if (attempts === 1) throw new Error('模拟 QuotaExceededError')
  return originalPut(...args)
}
await putInterpretationWithRetry(
  { ...baseRow, id: 'int-retry-ok' },
  { retries: 2, retryDelayMs: 1 }
)
assert.strictEqual(attempts, 2, '第一次失败后应自动发起第二次重试')
assert.ok(await db.interpretations.get('int-retry-ok'), '重试后判读记录应落库')

// 2) 全部失败 -> reject；外业 corals 不受影响
db.interpretations.put = async () => {
  throw new Error('模拟持续落账失败')
}
await assert.rejects(
  putInterpretationWithRetry({ ...baseRow, id: 'int-retry-fail' }, {
    retries: 1,
    retryDelayMs: 1
  }),
  /落账失败|模拟持续落账失败/
)
assert.strictEqual((await db.interpretations.get('int-retry-fail')) ?? null, null, '失败的判读记录不应落库')
const field = await db.corals.get('c-field-1')
assert.ok(field && field.coverCm === 1000, '外业珊瑚记录必须原样保留，不受判读落账失败影响')

// 3) 恢复后正常写
db.interpretations.put = originalPut
await putInterpretationWithRetry({ ...baseRow, id: 'int-final', updatedAt: now })
assert.ok(await db.interpretations.get('int-final'))

console.log('判读落账重试 + 外业隔离断言全部通过')
db.close()
