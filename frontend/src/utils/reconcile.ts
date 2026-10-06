/**
 * 两本台账对账与排位工具（熔化工段料液台账 ↔ 窑务退火排位台账）
 *
 * 规则：
 * - 排位前按批次号对账：批次对不上、或领用公斤数超过该批次当前可用余量 → 挂起，不占窑位。
 * - 「批次可用余量」= 批次余量 − 其余正常且未出炉排位已认领的公斤数。
 * - 已进窑（退火中 / 已出炉）的排位照当初认领的量烧完，不参与作废重排。
 * - 熔化工段领用公斤数更正后，用到该批且尚未进窑的正常排位作废，由窑务自动找空位重排；
 *   撞位或对账不过则落到「待排 / 挂起」队列，退回熔化工段确认。
 */
import type { Anneal, HoldState } from '../types/anneal'
import type { GlassBatch } from '../types/batch'
import { annealWindow, checkSlotConflict, kilnSlots, windowsOverlap } from './thermal'

/** 挂起原因：批次对不上 */
export const REASON_BATCH_MISMATCH = '批次对不上：料液台账中查无此批次'
/** 挂起原因前缀：领用超余量 */
export const REASON_OVER_REMAIN_PREFIX = '领用公斤数超过批次余量'

export interface ReconcileResult {
  /** 正常（对账通过） */
  ok: boolean
  /** 排位状态：正常 / 挂起 */
  holdState: Extract<HoldState, '正常' | '挂起'>
  /** 对账失败原因 */
  reason: string
  /** 命中的批次（对不上时为 null） */
  batch: GlassBatch | null
  /** 该批次当前可用余量（kg） */
  availableKg: number
}

/** 一条排位是否占用窑位参与判重：仅「正常」且未出炉的排位占窑位 */
export function occupiesSlot(row: Pick<Anneal, 'holdState' | 'state'>): boolean {
  return row.holdState === '正常' && row.state !== '已出炉'
}

/**
 * 批次可用余量：批次当前余量 − 其他正常未出炉排位已认领的公斤数。
 * 已进窑的排位领用的料已在取料环节扣过台账余量，这里只对尚未进窑的认领做预留对账。
 */
export function batchAvailableKg(
  batchId: string,
  batches: GlassBatch[],
  anneals: Anneal[],
  excludeAnnealId = '',
): number {
  const batch = batches.find((row) => row.id === batchId)
  if (batch === undefined) return 0
  const reserved = anneals
    .filter((row) => row.id !== excludeAnnealId && occupiesSlot(row) && row.batchId === batchId)
    .reduce((acc, row) => acc + (row.claimedKg ?? 0), 0)
  return Math.round((batch.remainKg - reserved) * 10) / 10
}

/** 对账：校验批次存在且领用公斤数不超过批次可用余量 */
export function reconcileClaim(
  batchId: string,
  claimedKg: number,
  batches: GlassBatch[],
  anneals: Anneal[],
  excludeAnnealId = '',
): ReconcileResult {
  const batch = batches.find((row) => row.id === batchId) ?? null
  if (batch === null) {
    return {
      ok: false,
      holdState: '挂起',
      reason: REASON_BATCH_MISMATCH,
      batch: null,
      availableKg: 0,
    }
  }
  const availableKg = batchAvailableKg(batchId, batches, anneals, excludeAnnealId)
  if (!(claimedKg > 0)) {
    return {
      ok: false,
      holdState: '挂起',
      reason: '领用公斤数必须大于 0',
      batch,
      availableKg,
    }
  }
  if (claimedKg > availableKg + 1e-6) {
    return {
      ok: false,
      holdState: '挂起',
      reason: `${REASON_OVER_REMAIN_PREFIX}：认领 ${claimedKg} kg，${batch.colorCode} 仅剩可用 ${availableKg} kg`,
      batch,
      availableKg,
    }
  }
  return { ok: true, holdState: '正常', reason: '', batch, availableKg }
}

/**
 * 在所有退火窑中为一条排位寻找时间窗不冲突的空窑位；找不到返回空串。
 * @param obstacles 占窑位的排位（仅正常未出炉记录才是障碍）
 * @param kilnCodes 退火窑号列表
 */
export function findFreeSlot(params: {
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>
  obstacles: Anneal[]
  kilnCodes: string[]
  wallThicknessOf: (pieceId: string) => number
  /** 优先尝试的原窑位（作废重排时先试原位） */
  preferredSlot?: string
}): string {
  const { candidate, obstacles, kilnCodes, wallThicknessOf, preferredSlot = '' } = params
  const ownThickness = wallThicknessOf(candidate.pieceId)
  const ownWindow = annealWindow(candidate, ownThickness)
  const isFree = (slot: string): boolean =>
    !obstacles.some((row) => {
      if (row.kilnSlot !== slot) return false
      const otherWindow = annealWindow(row, wallThicknessOf(row.pieceId))
      return windowsOverlap(ownWindow, otherWindow)
    })

  if (preferredSlot !== '' && isFree(preferredSlot)) return preferredSlot
  const allCodes = kilnCodes.length > 0 ? kilnCodes : ['AN-01']
  for (const code of allCodes) {
    for (const slot of kilnSlots(code)) {
      if (slot === preferredSlot) continue
      if (isFree(slot)) return slot
    }
  }
  return ''
}

/** 窑位冲突校验时忽略待排 / 挂起记录：它们不占窑位 */
export function slotObstacles(anneals: Anneal[]): Anneal[] {
  return anneals.filter((row) => occupiesSlot(row))
}

/** 重新跑一次窑位冲突检测（传入全部排位，内部自动剔除不占窑位的记录） */
export function conflictAmongAnneals(
  anneals: Anneal[],
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  wallThicknessOf: (pieceId: string) => number,
  excludeAnnealId = '',
) {
  return checkSlotConflict(slotObstacles(anneals), candidate, wallThicknessOf, excludeAnnealId)
}

export interface RescheduleOutcome {
  annealId: string
  pieceId: string
  holdState: HoldState
  /** 重排后窑位（待排 / 挂起为空串） */
  kilnSlot: string
  reason: string
  batchId: string
  claimedKg: number | null
}

/** 一批排位作废重排的汇总结果 */
export interface RescheduleSummary {
  /** 本次作废重排的排位条数 */
  invalidated: number
  /** 已重新占到空窑位（恢复正常） */
  resumed: number
  /** 对账通过但暂无空位，留在待排队列 */
  waiting: number
  /** 对账不过挂起，退回熔化工段确认 */
  held: number
  details: RescheduleOutcome[]
}

/**
 * 作废重排的单条结果归类：
 * 1. 重新对账不通过 → 挂起（退回熔化工段确认）；
 * 2. 对账通过、自动找到空窑位 → 正常（窑务找空位）；
 * 3. 对账通过但没有空窑位 → 待排（不占窑位，等空位）。
 */
export function planReschedule(params: {
  row: Anneal
  batches: GlassBatch[]
  obstacles: Anneal[]
  kilnCodes: string[]
  wallThicknessOf: (pieceId: string) => number
}): RescheduleOutcome {
  const { row, batches, obstacles, kilnCodes, wallThicknessOf } = params
  const claimed = row.claimedKg
  if (row.batchId === '' || claimed === null) {
    return {
      annealId: row.id,
      pieceId: row.pieceId,
      holdState: '挂起',
      kilnSlot: '',
      reason: '老排位未回填批次或领用公斤数，需熔化工段确认',
      batchId: row.batchId,
      claimedKg: claimed,
    }
  }
  const reconcile = reconcileClaim(row.batchId, claimed, batches, obstacles, row.id)
  if (!reconcile.ok) {
    return {
      annealId: row.id,
      pieceId: row.pieceId,
      holdState: '挂起',
      kilnSlot: '',
      reason: reconcile.reason,
      batchId: row.batchId,
      claimedKg: claimed,
    }
  }
  const slot = findFreeSlot({
    candidate: row,
    obstacles,
    kilnCodes,
    wallThicknessOf,
    preferredSlot: row.kilnSlot,
  })
  if (slot === '') {
    return {
      annealId: row.id,
      pieceId: row.pieceId,
      holdState: '待排',
      kilnSlot: '',
      reason: '对账通过，但当前没有时间窗空闲的窑位，退回窑务待排队列',
      batchId: row.batchId,
      claimedKg: claimed,
    }
  }
  return {
    annealId: row.id,
    pieceId: row.pieceId,
    holdState: '正常',
    kilnSlot: slot,
    reason: '',
    batchId: row.batchId,
    claimedKg: claimed,
  }
}

/** 从取料工序备注中解析领用公斤数，如「取 G-101 料液约 6.2 kg」→ 6.2；解析不出返回 null */
export function parseClaimedKg(remark: string): number | null {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*kg/i.exec(remark)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null
}
