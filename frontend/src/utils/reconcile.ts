/**
 * 对账工具：外业覆盖率与影像判读覆盖率按样带编号对账。
 * - 两侧覆盖率差过一成（>10 个百分点）→ 挂起，等复核
 * - 判读室还没判 → 按外业那份先出并标出来（未判读）
 * - 判读室重判后重新对账，差异不超一成 → 自动放行
 */
import type { BleachLevel, CoralRecord } from '@/types/coralRecord'
import type { InterpretationRecord } from '@/types/interpretation'
import { bleachGrade, bleachIndex, coralCoveragePct, round } from '@/utils/bleach'

/** 覆盖率差异阈值（个百分点）：差过一成即挂起 */
export const COVERAGE_DIFF_THRESHOLD_PCT = 10

/** 对账状态 */
export type ReconcileStatus = 'uninterpreted' | 'pending' | 'released'

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  uninterpreted: '未判读',
  pending: '挂起',
  released: '放行'
}

export interface ReconcileResult {
  /** 外业珊瑚覆盖率（%） */
  fieldCoveragePct: number
  /** 判读覆盖率（%），未判读时为 null */
  interpretationCoveragePct: number | null
  /** 两侧覆盖率差异绝对值（个百分点），未判读时为 null */
  diffPct: number | null
  /** 对账状态 */
  status: ReconcileStatus
  /** 是否挂起（两侧差过一成） */
  suspended: boolean
  /** 是否未判读（按外业那份先出） */
  uninterpreted: boolean
}

/** 由外业珊瑚记录计算样带覆盖率（%） */
export function fieldCoverageOfBelt(corals: CoralRecord[], beltLengthM: number): number {
  const coverCmTotal = round(
    corals.reduce((sum, coral) => sum + coral.coverCm, 0),
    1
  )
  return coralCoveragePct(coverCmTotal, beltLengthM)
}

/**
 * 对账：外业覆盖率 vs 判读记录。
 * 判读记录缺省时状态为「未判读」，按外业那份先出并标出。
 */
export function reconcileBelt(
  fieldCoveragePct: number,
  interpretation: InterpretationRecord | null | undefined
): ReconcileResult {
  if (!interpretation) {
    return {
      fieldCoveragePct,
      interpretationCoveragePct: null,
      diffPct: null,
      status: 'uninterpreted',
      suspended: false,
      uninterpreted: true
    }
  }
  const diff = round(Math.abs(fieldCoveragePct - interpretation.coveragePct), 2)
  const suspended = diff > COVERAGE_DIFF_THRESHOLD_PCT
  return {
    fieldCoveragePct,
    interpretationCoveragePct: round(interpretation.coveragePct, 2),
    diffPct: diff,
    status: suspended ? 'pending' : 'released',
    suspended,
    uninterpreted: false
  }
}

/**
 * 由现有珊瑚记录生成一版初始判读记录（升级迁移用）。
 * 覆盖率取外业珊瑚覆盖率，白化等级取覆盖长度加权的总体等级，判读人留空、标为初始值。
 */
export function initialInterpretationFromCorals(
  beltId: string,
  corals: CoralRecord[],
  beltLengthM: number,
  now: number
): Omit<InterpretationRecord, 'id'> {
  const coveragePct = fieldCoverageOfBelt(corals, beltLengthM)
  const index = bleachIndex(corals)
  const bleachLevel: BleachLevel = bleachGrade(index)
  return {
    beltId,
    coveragePct,
    bleachLevel,
    interpreter: '',
    initial: true,
    status: 'posted',
    postError: '',
    createdAt: now,
    updatedAt: now
  }
}
