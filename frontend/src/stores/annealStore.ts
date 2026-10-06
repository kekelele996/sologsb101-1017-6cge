/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段。排位前与熔化工段料液台账按批次对账：
 * 批次对不上或领用公斤数超余量 → 挂起不占窑位；窑位时间窗冲突时禁止提交，出炉即回写作品状态。
 * 熔化工段改了某批领用公斤数：用到这批未进窑的排位作废重排（db.consumeBatch 内完成）。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW, occupiesSlot } from '../types/anneal'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
} from '../utils/db'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import {
  annealStateTagType,
  findFreeSlot,
  reconcileAnneal,
  reconcileDraw,
  type ReconcileResult,
} from '../utils/reconcile'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉且已排位的记录占用（挂起 / 待排不占） */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const batches = ref<GlassBatch[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 批次号 → 色号 */
  const batchColorOf = (batchId: string): string =>
    batches.value.find((row) => row.id === batchId)?.colorCode ?? ''

  /** 作品挂的批次号 */
  const pieceBatchOf = (pieceId: string): string =>
    pieces.value.find((row) => row.id === pieceId)?.batchId ?? ''

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表（挂起 / 待排不占窑位） */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: occupiesSlot(row.state),
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  /** 挂起（对账失败，等熔化工段确认） */
  const heldAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.state === '挂起'))
  /** 撤回待排（窑位满，等空位） */
  const queuedAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.state === '待排'))

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      const color = batchColorOf(row.batchId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        color.toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 对一条排位做料液两账对账 */
  function reconcileOf(candidate: { pieceId: string; batchId: string; drawKg: number }): ReconcileResult {
    return reconcileDraw(
      { batchId: candidate.batchId, drawKg: candidate.drawKg },
      pieceBatchOf(candidate.pieceId),
      batches.value,
    )
  }

  /** 某件作品的窑位冲突检测（仅与占窑位记录判冲突；编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId' | 'state'>,
  ): SlotConflict {
    const occupying = anneals.value.filter((row) => occupiesSlot(row.state))
    return checkSlotConflict(occupying, candidate, wallThicknessOf, candidate.id)
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, batchRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.batches.toArray(),
          ])
          return { annealRows, pieceRows, batchRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, batchRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            batches.value = batchRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /**
   * 排位落库：先按批次对账，再判窑位冲突。
   * - 对账不过 → 落为「挂起」（不占窑位，保留意向窑位），仍返回该行；
   * - 对账通过但窑位冲突 → 返回 null，禁止提交（请换窑位 / 改时间）；
   * - 都通过 → 落为「待入窑」。
   */
  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const check = reconcileOf(draft)
    const state: AnnealState = check.ok ? '待入窑' : '挂起'

    if (check.ok) {
      const conflict = conflictOf({
        id: '',
        kilnSlot: draft.kilnSlot,
        inAt: draft.inAt,
        outAt: draft.outAt,
        curveSeg: draft.curveSeg,
        pieceId: draft.pieceId,
        state,
      })
      if (conflict.conflict) {
        lastMessage.value = conflict.message
        return null
      }
    }

    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      batchId: draft.batchId,
      drawKg: draft.drawKg,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state,
      holdReason: check.ok ? '' : check.reason,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = check.ok
      ? `已按批次 ${batchColorOf(draft.batchId) || draft.batchId} 对账通过，分配窑位 ${row.kilnSlot}`
      : `这一炉先挂起、不占窑位：${check.reason}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false

    // 已进窑 / 已出炉：批次与领用量照当初快照冻结，只能改曲线/时间等窑务字段
    const frozen = existing.state === '退火中' || existing.state === '已出炉'
    const batchId = frozen ? existing.batchId : draft.batchId
    const drawKg = frozen ? existing.drawKg : draft.drawKg

    let state: AnnealState = frozen ? existing.state : draft.state
    let holdReason = existing.holdReason
    if (!frozen) {
      const check = reconcileOf({ pieceId: draft.pieceId, batchId, drawKg })
      if (!check.ok) {
        state = '挂起'
        holdReason = check.reason
      } else {
        holdReason = ''
        // 对账通过即落为待入窑（编辑表单不允许直接造挂起 / 待排）
        state = '待入窑'
        const conflict = conflictOf({
          id: annealId,
          kilnSlot: draft.kilnSlot,
          inAt: draft.inAt,
          outAt: draft.outAt,
          curveSeg: draft.curveSeg,
          pieceId: draft.pieceId,
          state,
        })
        if (conflict.conflict) {
          lastMessage.value = conflict.message
          return false
        }
      }
    }

    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      batchId,
      drawKg,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state,
      holdReason,
    })
    revision.value += 1
    lastMessage.value = state === '挂起' ? `这一炉挂起、不占窑位：${holdReason}` : '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /**
   * 重新对账（挂起 / 待排行）：熔化工段补料或确认批次后，由窑务手动触发。
   * 通过则窑务自动找回空位落位；本窑满则撤回待排。
   */
  async function recheck(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    if (existing.state === '退火中' || existing.state === '已出炉') return existing.state

    const check = reconcileAnneal({ anneal: existing, pieces: pieces.value, batches: batches.value })
    if (!check.ok) {
      await putAnneal({ ...existing, state: '挂起', holdReason: check.reason })
      revision.value += 1
      lastMessage.value = `对账仍不通过，继续挂起：${check.reason}`
      return '挂起'
    }
    const free = findFreeSlot(existing, anneals.value, wallThicknessOf)
    if (free === null) {
      await putAnneal({
        ...existing,
        state: '待排',
        holdReason: '对账通过，但本窑窑位均被占用，撤回待排，等空位。',
      })
      revision.value += 1
      lastMessage.value = '对账通过，但暂无空位，已撤回待排。'
      return '待排'
    }
    const moved = free !== existing.kilnSlot
    await putAnneal({ ...existing, state: '待入窑', kilnSlot: free, holdReason: '' })
    revision.value += 1
    lastMessage.value = moved
      ? `对账通过，原窑位被占，已自动改排到空位 ${free}。`
      : `对账通过，已在窑位 ${free} 重新排位。`
    return '待入窑'
  }

  /** 一键重排全部挂起 / 待排：逐条重新对账并找回空位，返回落位/挂起/待排计数 */
  async function rerankAll(): Promise<{ placed: number; held: number; queued: number }> {
    const targets = anneals.value.filter((row) => row.state === '挂起' || row.state === '待排')
    let placed = 0
    let held = 0
    let queued = 0
    // 逐条落库，后一条能看到前一条已占的窑位
    for (const row of targets) {
      const next = await recheck(row.id)
      if (next === '待入窑') placed += 1
      else if (next === '挂起') held += 1
      else if (next === '待排') queued += 1
    }
    revision.value += 1
    lastMessage.value = `重排完成：落位 ${placed} 条、仍挂起 ${held} 条、待排 ${queued} 条。`
    return { placed, held, queued }
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态。挂起 / 待排不可推进。 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) {
      lastMessage.value = '挂起 / 待排的排位需先重新对账落位，不能直接进窑。'
      return null
    }
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    batches,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    heldAnneals,
    queuedAnneals,
    visibleAnneals,
    wallThicknessOf,
    batchColorOf,
    pieceBatchOf,
    reconcileOf,
    annealStateTagType,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    recheck,
    rerankAll,
    advance,
  }
})
