/**
 * 影像判读记录：影像判读室依据样带照片独立判出的一版覆盖率与白化等级。
 * 与外业队的 CoralRecord（属名 / 形态 / 覆盖长度）各存各的，按样带编号（beltId）对账。
 */
import type { BleachLevel } from '@/types/coralRecord'

/** 对账状态：两侧覆盖率差过一成（10 个百分点）的样带先挂起等复核 */
export type ReconcileStatus =
  /** 判读室尚未判读：汇总时暂用外业那份并标出 */
  | 'pending'
  /** 两侧覆盖率差值不超过 10 个百分点，对账一致 */
  | 'matched'
  /** 两侧覆盖率差值超过 10 个百分点，挂起等复核 */
  | 'held'
  /** 挂起后经判读室重判，无论差值是否仍超阈值一律自动放行 */
  | 'released'

/** 挂起阈值：两侧覆盖率差值的绝对值（个百分点） */
export const COVERAGE_DIFF_THRESHOLD_PCT = 10

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  pending: '待判读',
  matched: '对账一致',
  held: '挂起复核',
  released: '重判放行'
}

/** 判读记录来源：升级补录的初始值与判读室正式判读区分开 */
export type InterpretationSource = 'judged' | 'initial'

/** 影像判读记录：一条样带对应至多一条（按 beltId 唯一） */
export interface Interpretation {
  id: string
  /** 对账样带（外业样带 id；汇总时按样带编号逐一对账） */
  beltId: string
  /** 判读覆盖率（%，0 ~ 100，保留两位小数） */
  coveragePct: number
  /** 判读白化等级 无/轻/中/重/死亡 */
  bleachLevel: BleachLevel
  /** 判读人 */
  reviewer: string
  /** 判读日期（YYYY-MM-DD） */
  reviewedDate: string
  /** 判读备注（照片批次、疑点等） */
  remark: string
  /** 判读来源：judged=判读室正式判读，initial=旧数据升级时按外业记录补的初始值 */
  source: InterpretationSource
  /** 是否为重判（挂起的样带经重判后自动放行） */
  revised: boolean
  createdAt: number
  updatedAt: number
}

/** 判读录入草稿（存于 interpretStore） */
export interface InterpretationDraft {
  coveragePct: number
  bleachLevel: BleachLevel
  reviewer: string
  reviewedDate: string
  remark: string
}

export function createEmptyInterpretationDraft(): InterpretationDraft {
  return {
    coveragePct: 0,
    bleachLevel: '无',
    reviewer: '',
    reviewedDate: new Date().toISOString().slice(0, 10),
    remark: ''
  }
}

/**
 * 对账：按两侧覆盖率（%）与判读记录来源 / 是否重判计算样带状态。
 * - 判读室尚未判（无记录）或只有升级补录的初始值（source=initial，并非正式判读）：pending，暂用外业那份；
 * - 已经判读室重判（revised）：released，自动放行（无论差值是否仍超阈值）；
 * - 两侧覆盖率差过 10 个百分点：held，先挂起等复核；
 * - 其余（正式判读且差值不超阈值）：matched。
 */
export function reconcileCoverage(params: {
  interpretation: Pick<Interpretation, 'coveragePct' | 'revised' | 'source'> | null | undefined
  fieldCoveragePct: number
}): ReconcileStatus {
  const { interpretation, fieldCoveragePct } = params
  if (!interpretation || interpretation.source === 'initial') return 'pending'
  if (interpretation.revised) return 'released'
  const diff = Math.abs(Number(interpretation.coveragePct) - Number(fieldCoveragePct))
  return diff > COVERAGE_DIFF_THRESHOLD_PCT ? 'held' : 'matched'
}
