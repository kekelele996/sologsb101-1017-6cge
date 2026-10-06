/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 *
 * 与熔化工段料液台账按批次号对账：批次对不上 / 领用超余量 → 挂起不占窑位；
 * 熔化工段更正领用公斤数后，未进窑排位作废，由窑务自动找空位重排。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg, HoldState } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
  rescheduleAnneals,
  resolveLegacyAnneal,
} from '../utils/db'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import {
  conflictAmongAnneals,
  occupiesSlot,
  parseClaimedKg,
  reconcileClaim,
  slotObstacles,
  type ReconcileResult,
} from '../utils/reconcile'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
  holdState: HoldState | 'all'
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
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = {
  keyword: '',
  state: 'all',
  curveSeg: 'all',
  kilnCode: 'all',
  holdState: 'all',
}

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const batches = ref<GlassBatch[]>([])
  const steps = ref<Step[]>([])
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

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表：待排 / 挂起记录不占窑位 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .filter((row) => occupiesSlot(row))
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
          occupied: true,
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  /** 挂起：批次对不上 / 超余量，退回熔化工段确认 */
  const heldAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.holdState === '挂起'))
  /** 待排：作废重排后暂无空位，等窑务重新排位 */
  const waitingAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.holdState === '待排'))
  /** 老排位升级回填不出批次 / 领用公斤数，单列待人工确认 */
  const legacyAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.legacyUnresolved))

  function batchOf(batchId: string): GlassBatch | undefined {
    return batches.value.find((row) => row.id === batchId)
  }

  function colorCodeOf(batchId: string): string {
    if (batchId === '') return '未回填批次'
    return batchOf(batchId)?.colorCode ?? '批次已不在台账'
  }

  /** 排位表单的默认领用公斤数：优先取该作品「取料」工序备注里的公斤数 */
  function defaultClaimedKg(pieceId: string): number {
    const feed = steps.value.find((row) => row.pieceId === pieceId && row.name === '取料')
    return parseClaimedKg(feed?.remark ?? '') ?? 5
  }

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (filters.holdState !== 'all' && row.holdState !== filters.holdState) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        colorCodeOf(row.batchId).toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /**
   * 排位前对账：批次对不上 / 领用超余量即挂起。
   * 返回对账结果（ok=false 时 UI 允许以挂起状态落库，不占窑位）。
   */
  function reconcileOf(
    batchId: string,
    claimedKg: number,
    excludeAnnealId = '',
  ): ReconcileResult {
    return reconcileClaim(batchId, claimedKg, batches.value, anneals.value, excludeAnnealId)
  }

  /** 某件作品的窑位冲突检测（编辑时排除自身；自动忽略挂起 / 待排记录） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(slotObstacles(anneals.value), candidate, wallThicknessOf, candidate.id)
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
          const [annealRows, pieceRows, batchRows, stepRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.batches.toArray(),
            db.steps.toArray(),
          ])
          return { annealRows, pieceRows, batchRows, stepRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, batchRows, stepRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            batches.value = batchRows
            steps.value = stepRows
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
   * 新建排位：
   * - 对账不通过 → 挂起落库（kilnSlot 清空，不占窑位），等熔化工段确认；
   * - 对账通过但窑位冲突 → 拒绝提交（窑位冲突是硬约束）；
   * - 对账通过且窑位空闲 → 正常占窑位。
   */
  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const reconcile = reconcileOf(draft.batchId, draft.claimedKg)
    const holdState: HoldState = reconcile.ok ? '正常' : '挂起'
    if (reconcile.ok) {
      const conflict = conflictAmongAnneals(
        anneals.value,
        {
          id: '',
          kilnSlot: draft.kilnSlot,
          inAt: draft.inAt,
          outAt: draft.outAt,
          curveSeg: draft.curveSeg,
          pieceId: draft.pieceId,
        },
        wallThicknessOf,
      )
      if (conflict.conflict) {
        lastMessage.value = conflict.message
        return null
      }
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: reconcile.ok ? draft.kilnSlot : '',
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      batchId: draft.batchId,
      claimedKg: draft.claimedKg,
      holdState,
      holdReason: reconcile.reason,
      legacyUnresolved: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = reconcile.ok
      ? `对账通过（${reconcile.batch?.colorCode ?? ''} 可用余量 ${reconcile.availableKg} kg），已分配窑位 ${row.kilnSlot}`
      : `这一炉已挂起，不占窑位：${reconcile.reason}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    const reconcile = reconcileOf(draft.batchId, draft.claimedKg, annealId)
    if (reconcile.ok) {
      const conflict = conflictAmongAnneals(
        anneals.value,
        {
          id: annealId,
          kilnSlot: draft.kilnSlot,
          inAt: draft.inAt,
          outAt: draft.outAt,
          curveSeg: draft.curveSeg,
          pieceId: draft.pieceId,
        },
        wallThicknessOf,
      )
      if (conflict.conflict) {
        lastMessage.value = conflict.message
        return false
      }
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: reconcile.ok ? draft.kilnSlot : '',
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      batchId: draft.batchId,
      claimedKg: draft.claimedKg,
      holdState: reconcile.ok ? '正常' : '挂起',
      holdReason: reconcile.reason,
      // 人工在编辑弹窗补齐批次/领用公斤数后，老排位标记随之消除
      legacyUnresolved: false,
    })
    revision.value += 1
    lastMessage.value = reconcile.ok ? '退火编排已更新，对账通过' : `已改为挂起：${reconcile.reason}`
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  /** 重新排位（窑务找空位）：不传 id 则处理全部待排 / 挂起记录 */
  async function reschedule(annealIds?: string[]): Promise<{ resumed: number; waiting: number; held: number }> {
    const summary = await rescheduleAnneals(annealIds)
    revision.value += 1
    const parts: string[] = []
    if (summary.resumed > 0) parts.push(`${summary.resumed} 条已由窑务安排到空窑位`)
    if (summary.waiting > 0) parts.push(`${summary.waiting} 条暂无空位，留在待排队列`)
    if (summary.held > 0) parts.push(`${summary.held} 条对账不过，挂起退回熔化工段确认`)
    lastMessage.value = parts.length > 0 ? `重新排位完成：${parts.join('；')}。` : '没有可重新排位的记录。'
    return { resumed: summary.resumed, waiting: summary.waiting, held: summary.held }
  }

  /** 老排位回填确认：补齐批次与领用公斤数后立即重排 */
  async function resolveLegacy(
    annealId: string,
    patch: { batchId: string; claimedKg: number },
  ): Promise<boolean> {
    const summary = await resolveLegacyAnneal(annealId, patch)
    if (summary === null) return false
    revision.value += 1
    const resumed = summary.details.find((row) => row.annealId === annealId)
    lastMessage.value =
      resumed?.holdState === '正常'
        ? `老排位已回填并重新排位到窑位 ${resumed.kilnSlot}`
        : '老排位已回填，但仍需等待空位或熔化工段确认，已进入对应队列'
    return resumed?.holdState === '正常'
  }

  return {
    anneals,
    pieces,
    batches,
    steps,
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
    waitingAnneals,
    legacyAnneals,
    visibleAnneals,
    wallThicknessOf,
    batchOf,
    colorCodeOf,
    defaultClaimedKg,
    reconcileOf,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    reschedule,
    resolveLegacy,
  }
})
