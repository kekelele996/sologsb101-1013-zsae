/**
 * 影像判读 store：维护影像判读室自己的那版判读记录（判读覆盖率 / 判读等级 / 判读人），
 * 与外业数据各存各的；并按样带编号与外业覆盖率对账（差过一成挂起、未判读待判、重判放行）。
 *
 * 落账只写 interpretations 一张表：失败时仅重试判读这份，外业的样带 / 珊瑚记录不受影响。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, putInterpretationWithRetry, watchTable } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { BleachLevel, CoralRecord } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Interpretation, InterpretationDraft, ReconcileStatus } from '@/types/interpretation'
import { RECONCILE_STATUS_LABEL, reconcileCoverage } from '@/types/interpretation'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 判读室对账台账行（含外业侧全部覆盖度指标，供汇总页与判读台账共用同一口径） */
export interface ReconcileRow {
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  reefId: string
  reefName: string
  surveyDate: string
  observer: string
  lengthM: number
  orientation: string
  coralCount: number
  fieldCoverCmTotal: number
  /** 外业覆盖率（%） */
  fieldCoveragePct: number
  /** 外业白化指数 0 ~ 4 */
  bleachIndex: number
  fieldGrade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensityValue: number
  /** 判读覆盖率（%，未判读为 null） */
  interpretedCoveragePct: number | null
  /** 判读等级（未判读为 null） */
  interpretedGrade: BleachLevel | null
  /** 判读人（未判读为 null） */
  reviewer: string | null
  interpretation: Interpretation | null
  /** 两侧覆盖率差值绝对值（个百分点） */
  coverageDiffPct: number | null
  status: ReconcileStatus
  statusLabel: string
  /** 挂起样带不计入定稿礁区报告，其余照旧 */
  conclusive: boolean
  /** 数据来源是否为升级补录的初始值 */
  isInitial: boolean
}

/** 挂起 / 待判读在台账中优先排到前面 */
const STATUS_ORDER: Record<ReconcileStatus, number> = {
  held: 0,
  pending: 1,
  released: 2,
  matched: 3
}

/** 判读室台账筛选条件 */
export interface InterpretFilterState {
  keyword: string
  statuses: ReconcileStatus[]
  reefIds: string[]
}

export function createEmptyInterpretFilter(): InterpretFilterState {
  return { keyword: '', statuses: [], reefIds: [] }
}

export const useInterpretStore = defineStore('interpret', () => {
  const interpretations = ref<Interpretation[]>([])
  const belts = ref<Belt[]>([])
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const sites = ref<Site[]>([])
  const reefs = ref<Reef[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  /** 最近一次落账失败的判读行，供「重试自己那份」 */
  const lastFailedRow = ref<Interpretation | null>(null)
  const saving = ref(false)
  const filter = ref<InterpretFilterState>(createEmptyInterpretFilter())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Interpretation>(() => db.interpretations).subscribe((rows) => {
      interpretations.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
  }

  /** 样带 id → 最新判读记录（同带多条时取最近更新） */
  const interpretationByBelt = computed<Map<string, Interpretation>>(() => {
    const map = new Map<string, Interpretation>()
    interpretations.value
      .slice()
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .forEach((item) => map.set(item.beltId, item))
    return map
  })

  function interpretationOfBelt(beltId: string | null | undefined): Interpretation | null {
    if (!beltId) return null
    return interpretationByBelt.value.get(beltId) ?? null
  }

  /** 全部样带的两侧对账台账行（外业指标 + 判读指标 + 对账状态） */
  const reconcileRows = computed<ReconcileRow[]>(() =>
    belts.value
      .map((belt): ReconcileRow => {
        const site = sites.value.find((item) => item.id === belt.siteId) ?? null
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) ?? null : null
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltCorals.reduce((sum, coral) => sum + Math.max(0, coral.coverCm), 0),
          1
        )
        const fieldCoveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
        const index = bleachIndex(beltCorals)
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
            1
          )
        })
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        const invertebrateTotal = beltFishes
          .filter((fish) => fish.category === '无脊椎动物')
          .reduce((sum, fish) => sum + fish.count, 0)
        const interpretation = interpretationByBelt.value.get(belt.id) ?? null
        const status = reconcileCoverage({ interpretation, fieldCoveragePct })
        return {
          beltId: belt.id,
          beltNo: belt.no,
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          coralCount: beltCorals.length,
          fieldCoverCmTotal: coverCmTotal,
          fieldCoveragePct,
          bleachIndex: index,
          fieldGrade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltCorals),
          distribution,
          fishTotal,
          invertebrateTotal,
          fishDensityValue: fishDensity(fishTotal, belt.lengthM),
          interpretedCoveragePct: interpretation ? round(Number(interpretation.coveragePct), 2) : null,
          interpretedGrade: interpretation ? interpretation.bleachLevel : null,
          reviewer: interpretation?.reviewer || null,
          interpretation,
          coverageDiffPct: interpretation
            ? round(Math.abs(Number(interpretation.coveragePct) - fieldCoveragePct), 2)
            : null,
          status,
          statusLabel: RECONCILE_STATUS_LABEL[status],
          conclusive: status !== 'held',
          isInitial: interpretation?.source === 'initial'
        }
      })
      .sort((a, b) => {
        const orderDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (orderDiff !== 0) return orderDiff
        return a.beltNo.localeCompare(b.beltNo, 'zh-Hans-CN')
      })
  )

  /** 按筛选条件过滤后的对账行 */
  const filteredReconcileRows = computed<ReconcileRow[]>(() =>
    reconcileRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}${row.reviewer ?? ''}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.statuses.length > 0 && !filter.value.statuses.includes(row.status)) return false
      return true
    })
  )

  /** 对账状态计数（顶部徽标用） */
  const statusCounts = computed<Record<ReconcileStatus, number>>(() => {
    const counts: Record<ReconcileStatus, number> = { pending: 0, matched: 0, held: 0, released: 0 }
    reconcileRows.value.forEach((row) => {
      counts[row.status] += 1
    })
    return counts
  })

  /**
   * 按礁区的定稿汇总：定稿报告照旧，仅排除挂起等复核的样带；
   * 同时给出待判读 / 挂起 / 重判放行计数，便于出具结论时一眼看出哪些样带暂缺。
   */
  const reefSummaries = computed(() =>
    reefs.value.map((reef) => {
      const lines = reconcileRows.value.filter((row) => row.reefId === reef.id)
      const conclusive = lines.filter((row) => row.conclusive)
      const avgBleachIndex =
        conclusive.length === 0
          ? 0
          : round(conclusive.reduce((sum, row) => sum + row.bleachIndex, 0) / conclusive.length, 2)
      return {
        reefId: reef.id,
        reefName: reef.name,
        protectStatus: reef.protectStatus,
        siteCount: new Set(lines.map((row) => row.siteId)).size,
        beltCount: lines.length,
        conclusiveBeltCount: conclusive.length,
        coralCount: conclusive.reduce((sum, row) => sum + row.coralCount, 0),
        avgBleachIndex,
        grade: bleachGrade(avgBleachIndex),
        fishTotal: conclusive.reduce((sum, row) => sum + row.fishTotal, 0),
        pendingCount: lines.filter((row) => row.status === 'pending').length,
        heldCount: lines.filter((row) => row.status === 'held').length,
        releasedCount: lines.filter((row) => row.status === 'released').length
      }
    })
  )

  function patchFilter(patch: Partial<InterpretFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyInterpretFilter()
  }

  /**
   * 判读室落账（首判 / 重判）：
   * - 判读室此前没有正式判读（无记录或仅升级补录的初始值）视为首判，revised=false；
   * - 已有正式判读后再次提交视为重判，revised=true，挂起样带因此自动放行；
   * - 仅重试 interpretations 这份，全部失败时保留 lastFailedRow 供手动重试，外业数据不动。
   */
  async function saveInterpretation(beltId: string, draft: InterpretationDraft): Promise<Interpretation> {
    const existing = interpretationByBelt.value.get(beltId) ?? null
    const hadFormalJudge = existing !== null && existing.source !== 'initial'
    const now = Date.now()
    const row: Interpretation = {
      id: existing?.id ?? createId('int'),
      beltId,
      coveragePct: round(Math.min(100, Math.max(0, Number(draft.coveragePct))), 2),
      bleachLevel: draft.bleachLevel,
      reviewer: draft.reviewer.trim(),
      reviewedDate: draft.reviewedDate,
      remark: draft.remark.trim(),
      source: 'judged',
      revised: hadFormalJudge,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    saving.value = true
    error.value = null
    try {
      await putInterpretationWithRetry(row)
      lastFailedRow.value = null
      return row
    } catch (saveError) {
      lastFailedRow.value = row
      error.value = saveError instanceof Error ? saveError.message : '判读记录落账失败'
      throw saveError
    } finally {
      saving.value = false
    }
  }

  /** 落账失败后重试：只重放判读那份，外业那份不受影响 */
  async function retryFailedWrite(): Promise<boolean> {
    if (!lastFailedRow.value) return true
    saving.value = true
    try {
      await putInterpretationWithRetry(lastFailedRow.value)
      error.value = null
      lastFailedRow.value = null
      return true
    } catch (saveError) {
      error.value = saveError instanceof Error ? saveError.message : '判读记录落账失败'
      return false
    } finally {
      saving.value = false
    }
  }

  /** 删除某样带的判读记录（级联删带时用，独立表不影响外业） */
  async function removeInterpretationByBelt(beltId: string): Promise<void> {
    await db.interpretations.where('beltId').equals(beltId).delete()
  }

  return {
    interpretations,
    ready,
    error,
    saving,
    lastFailedRow,
    filter,
    reconcileRows,
    filteredReconcileRows,
    reefSummaries,
    statusCounts,
    interpretationByBelt,
    start,
    interpretationOfBelt,
    patchFilter,
    resetFilter,
    saveInterpretation,
    retryFailedWrite,
    removeInterpretationByBelt
  }
})
