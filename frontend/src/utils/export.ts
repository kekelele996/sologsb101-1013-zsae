/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import type { InterpretationRecord } from '@/types/interpretation'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import { reconcileBelt } from '@/utils/reconcile'

/** 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes', 'interpretations'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, interpretations] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.interpretations.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    interpretations
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    interpretations: obj.interpretations ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    interpretations: payload.interpretations.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.interpretations], async () => {
    await db.reefs.bulkPut(payload.reefs)
    await db.sites.bulkPut(payload.sites)
    await db.belts.bulkPut(payload.belts)
    await db.corals.bulkPut(payload.corals)
    await db.fishes.bulkPut(payload.fishes)
    await db.interpretations.bulkPut(payload.interpretations)
  })
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  const interpretations = payload.interpretations.map((interpretation) => ({
    ...interpretation,
    id: createId('intp'),
    beltId: beltMap.get(interpretation.beltId) ?? interpretation.beltId
  }))
  return { ...payload, reefs, sites, belts, corals, fishes, interpretations }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  /** 判读覆盖率（%），未判读时为 null */
  interpretationCoveragePct: number | null
  /** 判读白化等级，未判读时为 null */
  interpretationGrade: BleachLevel | null
  /** 判读人 */
  interpreter: string
  /** 两侧覆盖率差异绝对值（个百分点），未判读时为 null */
  coverageDiffPct: number | null
  /** 对账状态 */
  reconcileStatus: 'uninterpreted' | 'pending' | 'released'
  /** 是否挂起（两侧差过一成） */
  suspended: boolean
  /** 是否未判读（按外业那份先出并标出） */
  uninterpreted: boolean
  conclusion: string
}

/** 按样带生成覆盖度结论行 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })
  const interpretationByBelt = new Map<string, InterpretationRecord>()
  payload.interpretations.forEach((interpretation) => {
    interpretationByBelt.set(interpretation.beltId, interpretation)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const fieldCoverage = coralCoveragePct(coverCmTotal, belt.lengthM)
      const interpretation = interpretationByBelt.get(belt.id) ?? null
      const reconcile = reconcileBelt(fieldCoverage, interpretation)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      const density = fishDensity(fishTotal, belt.lengthM)
      let conclusion: string
      if (corals.length === 0) {
        conclusion = '该样带尚未录入珊瑚记录'
      } else if (reconcile.suspended) {
        conclusion = `外业覆盖率 ${fieldCoverage}% 与判读覆盖率 ${reconcile.interpretationCoveragePct}% 差过一成（差 ${reconcile.diffPct} 个百分点），样带挂起等复核`
      } else if (reconcile.uninterpreted) {
        conclusion = `珊瑚覆盖率 ${fieldCoverage}%（按外业那份先出，判读室尚未判读），白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      } else if (grade === '无') {
        conclusion = `珊瑚覆盖率 ${fieldCoverage}%，未见白化`
      } else {
        conclusion = `珊瑚覆盖率 ${fieldCoverage}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: fieldCoverage,
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: density,
        interpretationCoveragePct: reconcile.interpretationCoveragePct,
        interpretationGrade: interpretation?.bleachLevel ?? null,
        interpreter: interpretation?.interpreter ?? '',
        coverageDiffPct: reconcile.diffPct,
        reconcileStatus: reconcile.status,
        suspended: reconcile.suspended,
        uninterpreted: reconcile.uninterpreted,
        conclusion
      }
    })
    .sort((a, b) => {
      if (a.suspended !== b.suspended) return a.suspended ? -1 : 1
      return b.bleachIndex - a.bleachIndex
    })
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级 */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const corals = payload.corals.filter((coral) => beltIds.has(coral.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      coralCount: corals.length,
      coverCmTotal: round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}
