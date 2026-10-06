/**
 * 料液两账对账与作废重排（纯函数）
 *
 * 熔化工段料液台账记批次（色号、配方、余量），窑务退火账记窑位与入窑排位，两本各记各的。
 * 窑务排位前先认「这件作品取料用的批次 + 领用公斤数」，两边按批次号对账：
 *  - 批次对不上（作品挂的批次与排位认的批次不一致、批次已删）
 *  - 或领用公斤数超过该批余量
 *  → 这一炉先挂起，不占窑位，等熔化工段确认。
 *
 * 已进窑（退火中 / 已出炉）的排位照当初领的量烧完，批次与领用量快照冻结，不再参与对账与重排。
 */
import type { Anneal, AnnealState } from '../types/anneal'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import { annealWindow, checkSlotConflict, kilnSlots, windowsOverlap } from './thermal'

/** 对账结果 */
export interface ReconcileResult {
  /** 对账是否通过 */
  ok: boolean
  /** 不通过时的挂起原因 */
  reason: string
}

/**
 * 排位前按批次号对账。
 * @param candidate 排位认的批次与领用公斤数（batchId 为空代表老账回填不出来）
 * @param pieceBatchId 作品挂的批次（熔化工段取料批次）
 * @param batches 料液台账（以批次号为准）
 */
export function reconcileDraw(
  candidate: { batchId: string; drawKg: number },
  pieceBatchId: string,
  batches: GlassBatch[],
): ReconcileResult {
  if (candidate.batchId === '') {
    return { ok: false, reason: '老排位未记批次且回填不出，需熔化工段确认批次后再排。' }
  }
  const batch = batches.find((row) => row.id === candidate.batchId)
  if (batch === undefined) {
    return { ok: false, reason: `料液台账中找不到批次 ${candidate.batchId}，批次对不上，先挂起。` }
  }
  if (pieceBatchId === '' || candidate.batchId !== pieceBatchId) {
    const pieceBatch = batches.find((row) => row.id === pieceBatchId)
    return {
      ok: false,
      reason: `排位认的批次 ${batch.colorCode} 与作品取料批次「${pieceBatch?.colorCode ?? (pieceBatchId || '未挂批次')}」对不上，先挂起。`,
    }
  }
  if (!(candidate.drawKg > 0)) {
    return { ok: false, reason: `批次 ${batch.colorCode} 的领用公斤数未填写（需 > 0），先挂起。` }
  }
  if (candidate.drawKg > batch.remainKg + 1e-9) {
    return {
      ok: false,
      reason: `批次 ${batch.colorCode} 领用 ${candidate.drawKg} kg 超过余量 ${batch.remainKg} kg，先挂起。`,
    }
  }
  return { ok: true, reason: '' }
}

export interface ReconcileContext {
  anneal: Pick<Anneal, 'pieceId' | 'batchId' | 'drawKg'>
  pieces: Piece[]
  batches: GlassBatch[]
}

/** 对一条排位做对账（便捷封装，作品缺失也算对不上） */
export function reconcileAnneal(ctx: ReconcileContext): ReconcileResult {
  const piece = ctx.pieces.find((row) => row.id === ctx.anneal.pieceId)
  if (piece === undefined) {
    return { ok: false, reason: '排位关联的作品已不存在，批次无从核对，先挂起。' }
  }
  return reconcileDraw(
    { batchId: ctx.anneal.batchId, drawKg: ctx.anneal.drawKg },
    piece.batchId,
    ctx.batches,
  )
}

/** 某台退火窑（按窑号）的候选窑位顺序：原窑位优先，再按 A1…C3 找空位 */
export function candidateSlots(kilnCode: string, preferredSlot: string): string[] {
  const all = kilnSlots(kilnCode)
  const rest = all.filter((slot) => slot !== preferredSlot)
  return [preferredSlot, ...rest]
}

/** 从窑位串中取窑号，如 AN-01-A1 → AN-01 */
export function kilnCodeOf(slot: string): string {
  return slot.split('-').slice(0, -1).join('-')
}

/**
 * 为一条未进窑排位找回空位：原窑位优先，撞别人就按窑位顺序找下一个空位，绝不占别人窑位。
 * 仅与「占窑位」状态（待入窑 / 退火中）的记录判冲突。
 * @returns 可用窑位；一台窑内全部撞满时返回 null（撤回待排，等空位）
 */
export function findFreeSlot(
  anneal: Pick<Anneal, 'id' | 'pieceId' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg'>,
  existing: Anneal[],
  wallThicknessOf: (pieceId: string) => number,
): string | null {
  const code = kilnCodeOf(anneal.kilnSlot) || 'AN-01'
  const occupying = existing.filter((row) => row.id !== anneal.id && ['待入窑', '退火中'].includes(row.state))
  for (const slot of candidateSlots(code, anneal.kilnSlot)) {
    const conflict = checkSlotConflict(
      occupying,
      { ...anneal, kilnSlot: slot },
      wallThicknessOf,
      anneal.id,
    )
    if (!conflict.conflict) return slot
  }
  return null
}

/**
 * 作废重排的落地状态。
 * - keep：对账已不过 → 维持挂起，等熔化工段确认
 * - place：对账通过且找回空位 → 落位为待入窑（movedFrom 非空表示从撞位窑位挪走）
 * - queue：对账通过但本窑窑位全满 → 撤回待排，等空位
 */
export type RerankOutcome =
  | { kind: 'keep'; state: '挂起'; reason: string }
  | { kind: 'place'; state: '待入窑'; kilnSlot: string; reason: ''; movedFrom: string }
  | { kind: 'queue'; state: '待排'; kilnSlot: string; reason: string }

/**
 * 对一条未进窑排位执行「先对账、后找回空位」的重排决策（不落库）。
 * @param reasonPrefix 作废触发说明（如「熔化工段改了 A-207 的领用公斤数」）
 */
export function rerankAnneal(
  anneal: Anneal,
  existing: Anneal[],
  pieces: Piece[],
  batches: GlassBatch[],
  wallThicknessOf: (pieceId: string) => number,
  reasonPrefix = '',
): RerankOutcome {
  const check = reconcileAnneal({ anneal, pieces, batches })
  if (!check.ok) {
    return { kind: 'keep', state: '挂起', reason: check.reason }
  }
  const free = findFreeSlot(anneal, existing, wallThicknessOf)
  if (free === null) {
    return {
      kind: 'queue',
      state: '待排',
      kilnSlot: anneal.kilnSlot,
      reason: `${reasonPrefix}原窑位及同窑空位均被占用，撤回待排，等窑位。`.trim(),
    }
  }
  const moved = free !== anneal.kilnSlot
  return {
    kind: 'place',
    state: '待入窑',
    kilnSlot: free,
    reason: '',
    movedFrom: moved ? anneal.kilnSlot : '',
  }
}

/** 重排统计 */
export interface RerankSummary {
  /** 作废后重新落位（含挪到别的空位） */
  placed: number
  /** 对账仍不过、维持挂起 */
  held: number
  /** 窑位满、撤回待排 */
  queued: number
  /** 本次涉及的排位总数 */
  total: number
}

export function emptyRerankSummary(): RerankSummary {
  return { placed: 0, held: 0, queued: 0, total: 0 }
}

/** 判断一批占窑位记录在给定窑位/时间窗下是否冲突（供表单实时提示复用） */
export function slotTakenByOthers(
  existing: Anneal[],
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  wallThicknessOf: (pieceId: string) => number,
): boolean {
  const ownWindow = annealWindow(candidate, wallThicknessOf(candidate.pieceId))
  return existing.some((row) => {
    if (row.id === candidate.id) return false
    if (!['待入窑', '退火中'].includes(row.state)) return false
    if (row.kilnSlot !== candidate.kilnSlot) return false
    return windowsOverlap(ownWindow, annealWindow(row, wallThicknessOf(row.pieceId)))
  })
}

/** 状态对应的标签色 */
export function annealStateTagType(state: AnnealState): 'info' | 'danger' | 'warning' | 'success' | 'primary' {
  switch (state) {
    case '待入窑':
      return 'info'
    case '挂起':
      return 'danger'
    case '待排':
      return 'warning'
    case '退火中':
      return 'warning'
    case '已出炉':
      return 'success'
    default:
      return 'info'
  }
}
