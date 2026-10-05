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
import type { Interpretation } from '@/types/interpretation'
import { reconcileCoverage } from '@/types/interpretation'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名（v3 起含 interpretations 影像判读表） */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes', 'interpretations'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** v3 之前的备份不含判读表，允许该字段缺失 */
const REQUIRED_BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const

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
  for (const key of REQUIRED_BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  // v3 新增的判读表：旧备份缺失不算错误，按空数组合并（进库后样带呈「待判读」）
  if (obj.interpretations !== undefined && !Array.isArray(obj.interpretations)) {
    errors.push('interpretations 字段应为数组')
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
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.interpretations],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      await db.interpretations.bulkPut(payload.interpretations)
    }
  )
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
    id: createId('int'),
    beltId: beltMap.get(interpretation.beltId) ?? interpretation.beltId
  }))
  return { ...payload, reefs, sites, belts, corals, fishes, interpretations }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度，并与影像判读室对账 */
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
  /** 外业覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 外业总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  /** 影像判读记录（未判读时为 null） */
  interpretation: Interpretation | null
  /** 判读覆盖率（%，未判读为 null） */
  interpretedCoveragePct: number | null
  /** 判读等级（未判读为 null） */
  interpretedGrade: BleachLevel | null
  /** 两侧覆盖率差值绝对值（个百分点，未判读为 null） */
  coverageDiffPct: number | null
  /** 对账状态：pending 待判读 / matched 一致 / held 挂起 / released 重判放行 */
  reconcileStatus: 'pending' | 'matched' | 'held' | 'released'
  /** 是否计入定稿礁区结论：挂起等复核的样带不计入，其余照旧 */
  conclusive: boolean
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
  // 影像判读室那份：一条样带至多一条，重复时取最近更新的
  const interpretationByBelt = new Map<string, Interpretation>()
  payload.interpretations.forEach((interpretation) => {
    const previous = interpretationByBelt.get(interpretation.beltId)
    if (!previous || interpretation.updatedAt >= previous.updatedAt) {
      interpretationByBelt.set(interpretation.beltId, interpretation)
    }
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
      const fieldCoveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
      const interpretation = interpretationByBelt.get(belt.id) ?? null
      const interpretedCoveragePct = interpretation ? round(Number(interpretation.coveragePct), 2) : null
      const interpretedGrade = interpretation ? interpretation.bleachLevel : null
      const reconcileStatus = reconcileCoverage({
        interpretation,
        fieldCoveragePct
      })
      // 只有「挂起等复核」的样带暂不计入定稿；待判读先按外业出（照旧），重判后自动放行
      const conclusive = reconcileStatus !== 'held'
      const coverageDiffPct =
        interpretedCoveragePct === null ? null : round(Math.abs(interpretedCoveragePct - fieldCoveragePct), 2)
      const baseText =
        corals.length === 0
          ? '该样带尚未录入珊瑚记录'
          : grade === '无'
            ? `珊瑚覆盖率 ${fieldCoveragePct}%，未见白化`
            : `珊瑚覆盖率 ${fieldCoveragePct}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      const reconcileSuffix =
        reconcileStatus === 'pending'
          ? '【判读室尚未判，暂按外业数据出，待补判】'
          : reconcileStatus === 'held'
            ? `【与判读覆盖率 ${interpretedCoveragePct}% 差 ${coverageDiffPct} 个百分点，挂起等复核，暂不计入定稿】`
            : reconcileStatus === 'released'
              ? '【挂起后经判读室重判，已自动放行】'
              : ''
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
        coveragePct: fieldCoveragePct,
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        interpretation,
        interpretedCoveragePct,
        interpretedGrade,
        coverageDiffPct,
        reconcileStatus,
        conclusive,
        conclusion: `${baseText}${reconcileSuffix}`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数、总体等级与两侧对账计数 */
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
  /** 判读室尚未判读的样带数（先按外业出） */
  pendingCount: number
  /** 两侧差过一成挂起等复核的样带数（不计入定稿） */
  heldCount: number
  /** 挂起后重判自动放行的样带数 */
  releasedCount: number
  /** 计入定稿结论的样带数（排除挂起） */
  conclusiveBeltCount: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const corals = payload.corals.filter((coral) => beltIds.has(coral.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    // 定稿结论照旧：只平均未挂起的样带
    const conclusiveLines = lines4Reef.filter((line) => line.conclusive)
    const avgBleachIndex =
      conclusiveLines.length === 0
        ? 0
        : round(conclusiveLines.reduce((sum, line) => sum + line.bleachIndex, 0) / conclusiveLines.length, 2)
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
        .reduce((sum, fish) => sum + fish.count, 0),
      pendingCount: lines4Reef.filter((line) => line.reconcileStatus === 'pending').length,
      heldCount: lines4Reef.filter((line) => line.reconcileStatus === 'held').length,
      releasedCount: lines4Reef.filter((line) => line.reconcileStatus === 'released').length,
      conclusiveBeltCount: conclusiveLines.length
    }
  })
}
