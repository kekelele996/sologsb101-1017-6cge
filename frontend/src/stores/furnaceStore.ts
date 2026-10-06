/**
 * 窑炉与料液状态管理（Pinia）
 * 维护窑炉列表、料液批次及剩余量；取料按剩余量扣减，低于阈值高亮提示补料。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace, FurnaceDraft, FurnaceState, FurnaceType } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  consumeBatch,
  correctBatchRemain,
  countAll,
  db,
  initDatabase,
  putBatch,
  putFurnace,
  removeBatch,
  removeFurnace,
} from '../utils/db'
import { LOW_REMAIN_KG, isLowRemain } from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 窑炉筛选条件 */
export interface FurnaceFilters {
  keyword: string
  type: FurnaceType | 'all'
  state: FurnaceState | 'all'
}

/** 单台窑炉的派生统计 */
export interface FurnaceStat {
  furnaceId: string
  batchCount: number
  totalRemainKg: number
  lowCount: number
  /** 关联作品数（通过料液批次反查） */
  pieceCount: number
}

const EMPTY_FILTERS: FurnaceFilters = { keyword: '', type: 'all', state: 'all' }

const EMPTY_STAT: Omit<FurnaceStat, 'furnaceId'> = {
  batchCount: 0,
  totalRemainKg: 0,
  lowCount: 0,
  pieceCount: 0,
}

let subscribed = false

export const useFurnaceStore = defineStore('furnace', () => {
  const furnaces = ref<Furnace[]>([])
  const batches = ref<GlassBatch[]>([])
  const pieces = ref<{ id: string; batchId: string }[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<FurnaceFilters>({ ...EMPTY_FILTERS })

  const meltingFurnaces = computed<Furnace[]>(() =>
    furnaces.value.filter((row) => row.type === '熔化炉' || row.type === '坩埚炉')
  )
  const annealingFurnaces = computed<Furnace[]>(() => furnaces.value.filter((row) => row.type === '退火窑'))
  const lowRemainBatches = computed<GlassBatch[]>(() => batches.value.filter((row) => isLowRemain(row.remainKg)))

  const stats = computed<Record<string, FurnaceStat>>(() => {
    const result: Record<string, FurnaceStat> = {}
    furnaces.value.forEach((furnace) => {
      const list = batches.value.filter((row) => row.furnaceId === furnace.id)
      const batchIds = new Set(list.map((row) => row.id))
      result[furnace.id] = {
        furnaceId: furnace.id,
        batchCount: list.length,
        totalRemainKg: Math.round(list.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
        lowCount: list.filter((row) => isLowRemain(row.remainKg)).length,
        pieceCount: pieces.value.filter((row) => batchIds.has(row.batchId)).length,
      }
    })
    return result
  })

  const visibleFurnaces = computed<Furnace[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return furnaces.value.filter((furnace) => {
      if (filters.type !== 'all' && furnace.type !== filters.type) return false
      if (filters.state !== 'all' && furnace.state !== filters.state) return false
      if (keyword === '') return true
      return (
        furnace.code.toLowerCase().includes(keyword) ||
        furnace.type.toLowerCase().includes(keyword) ||
        furnace.fuelType.toLowerCase().includes(keyword)
      )
    })
  })

  function statOf(furnaceId: string): FurnaceStat {
    return stats.value[furnaceId] ?? { furnaceId, ...EMPTY_STAT }
  }

  function batchesOf(furnaceId: string): GlassBatch[] {
    return batches.value.filter((row) => row.furnaceId === furnaceId)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [furnaceRows, batchRows, pieceRows] = await Promise.all([
            db.furnaces.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
          ])
          return { furnaceRows, batchRows, pieceRows }
        }).subscribe({
          next: ({ furnaceRows, batchRows, pieceRows }) => {
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            batches.value = [...batchRows].sort((a, b) => b.meltDate.localeCompare(a.meltDate))
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId }))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取窑炉数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<FurnaceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createFurnace(draft: FurnaceDraft): Promise<Furnace> {
    const stamp = nowIso()
    const row: Furnace = {
      id: uuid('furnace'),
      code: draft.code.trim() || '未编号窑炉',
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putFurnace(row)
    revision.value += 1
    lastMessage.value =
      row.type === '退火窑' ? `已新建退火窑「${row.code}」，窑位已进入窑位池` : `已新建窑炉「${row.code}」，可挂料液批次`
    return row
  }

  async function updateFurnace(furnaceId: string, draft: FurnaceDraft): Promise<void> {
    const existing = furnaces.value.find((row) => row.id === furnaceId)
    if (existing === undefined) return
    await putFurnace({
      ...existing,
      code: draft.code.trim() || existing.code,
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
    })
    revision.value += 1
  }

  async function deleteFurnace(furnaceId: string): Promise<void> {
    await removeFurnace(furnaceId)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '窑炉及其料液批次已删除'
  }

  async function createBatch(draft: GlassBatchDraft): Promise<GlassBatch> {
    const stamp = nowIso()
    const row: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || '未命名色号',
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    revision.value += 1
    return row
  }

  async function updateBatch(batchId: string, draft: GlassBatchDraft): Promise<void> {
    const existing = batches.value.find((row) => row.id === batchId)
    if (existing === undefined) return
    await putBatch({
      ...existing,
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || existing.colorCode,
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
    })
    revision.value += 1
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    revision.value += 1
  }

  /** 取料：按剩余量扣减，返回实际扣减量 */
  async function consume(batchId: string, kg: number): Promise<number> {
    const actual = await consumeBatch(batchId, kg)
    revision.value += 1
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch !== undefined) {
      const remain = Math.round((batch.remainKg - actual) * 10) / 10
      lastMessage.value = isLowRemain(remain)
        ? `已取料 ${actual} kg，${batch.colorCode} 剩余 ${remain} kg，低于 ${LOW_REMAIN_KG} kg，请及时补料`
        : `已取料 ${actual} kg，${batch.colorCode} 剩余 ${remain} kg`
    }
    return actual
  }

  /** 补料：直接增加剩余量；不碰窑务已排好的窑位 */
  async function refill(batchId: string, kg: number): Promise<void> {
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch === undefined) return
    await putBatch({ ...batch, remainKg: Math.round((batch.remainKg + kg) * 10) / 10 })
    revision.value += 1
    lastMessage.value = `已为 ${batch.colorCode} 补料 ${kg} kg，窑务已排窑位不受影响`
  }

  /**
   * 领用公斤数更正（熔化工段改某批的领用量 → 直接校正台账余量）。
   * 用到这批还没进窑的排位自动作废重排：窑务先找空位，对账不过 / 无空位则挂起待排；
   * 已进窑（退火中 / 已出炉）的排位照当初认领的量烧完，不动。
   */
  async function correctClaim(batchId: string, nextRemainKg: number): Promise<void> {
    const result = await correctBatchRemain(batchId, Math.round(nextRemainKg * 10) / 10)
    revision.value += 1
    const { deltaKg, reschedule } = result
    const parts: string[] = []
    if (reschedule.invalidated === 0) {
      parts.push('没有用到这批且未进窑的排位，窑位无变化')
    } else {
      parts.push(`已作废 ${reschedule.invalidated} 条未进窑排位`)
      if (reschedule.resumed > 0) parts.push(`${reschedule.resumed} 条已由窑务重新安排到空窑位`)
      if (reschedule.waiting > 0) parts.push(`${reschedule.waiting} 条暂无空位待排`)
      if (reschedule.held > 0) parts.push(`${reschedule.held} 条对账不过挂起`)
    }
    lastMessage.value = `已更正 ${result.batch.colorCode} 台账余量（${deltaKg > 0 ? '+' : ''}${deltaKg} kg）：${parts.join('，')}。`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    furnaces,
    batches,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    meltingFurnaces,
    annealingFurnaces,
    lowRemainBatches,
    stats,
    visibleFurnaces,
    statOf,
    batchesOf,
    loadAll,
    setFilters,
    resetFilters,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatch,
    deleteBatch,
    consume,
    refill,
    correctClaim,
    refreshCounts,
  }
})
