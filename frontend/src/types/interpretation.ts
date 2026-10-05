/**
 * 影像判读记录：判读室用样带照片另判的一版覆盖率与白化等级。
 * 与外业队的珊瑚记录（CoralRecord）各留各的，按样带编号对账。
 */
import type { BleachLevel } from '@/types/coralRecord'

/** 判读记录落账状态 */
export type InterpretationStatus = 'draft' | 'posted' | 'failed'

export const INTERPRETATION_STATUSES: InterpretationStatus[] = ['draft', 'posted', 'failed']

export const INTERPRETATION_STATUS_LABEL: Record<InterpretationStatus, string> = {
  draft: '草稿',
  posted: '已落账',
  failed: '落账失败'
}

export interface InterpretationRecord {
  id: string
  /** 所属样带（一条样带最多一条判读记录） */
  beltId: string
  /** 判读覆盖率（%） */
  coveragePct: number
  /** 判读白化等级 */
  bleachLevel: BleachLevel
  /** 判读人 */
  interpreter: string
  /** 是否初始值：升级时按现有珊瑚记录补的一版 */
  initial: boolean
  /** 落账状态 */
  status: InterpretationStatus
  /** 最近一次落账失败原因（status=failed 时有值） */
  postError: string
  createdAt: number
  updatedAt: number
}

/** 判读记录草稿（存于 surveyStore / 判读面板） */
export interface InterpretationDraft {
  coveragePct: number
  bleachLevel: BleachLevel
  interpreter: string
}

export function createEmptyInterpretationDraft(): InterpretationDraft {
  return {
    coveragePct: 0,
    bleachLevel: '无',
    interpreter: ''
  }
}
