/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑；v1 → v2 为 Piece 增加 craft 索引并回填默认值
 * - 提供各表增删改查、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal, HoldState } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { nowIso } from './id'
import { parseClaimedKg, planReschedule, occupiesSlot, type RescheduleSummary } from './reconcile'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：两本台账按批次对账，排位快照批次/领用公斤数，老排位回填 ----------
    this.version(DB_SCHEMA_VERSION).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      // holdState / batchId 为 v3 新增索引
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, holdState, batchId',
      inspects: 'id, pieceId, date, result, inspector',
    }).upgrade(async (tx) => {
      const pieceRows = await tx.table('pieces').toCollection().toArray()
      const stepRows = await tx.table('steps').toCollection().toArray()
      const batchRows = await tx.table('batches').toCollection().toArray()
      const batchIds = new Set(batchRows.map((row: { id?: unknown }) => row.id))
      const pieceBatch = new Map<string, string>(
        pieceRows.map((row: { id: string; batchId?: unknown }) => [row.id, typeof row.batchId === 'string' ? row.batchId : '']),
      )

      // 老排位没记批次：按作品挂的批次回填；领用公斤数从该作品「取料」工序备注解析；
      // 批次填不出（作品批次为空 / 批次已不在台账）或领用公斤数解析不出 → legacyUnresolved 单列。
      await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
        const pieceId = typeof row.pieceId === 'string' ? row.pieceId : ''
        const batchId = pieceBatch.get(pieceId) ?? ''
        const feedStep = stepRows.find(
          (step: { pieceId: string; name?: unknown; remark?: unknown }) =>
            step.pieceId === pieceId && step.name === '取料' && typeof step.remark === 'string',
        )
        const claimedKg = parseClaimedKg(typeof feedStep?.remark === 'string' ? feedStep.remark : '')
        const batchKnown = batchId !== '' && batchIds.has(batchId)

        if (typeof row.batchId !== 'string') row.batchId = batchKnown ? batchId : ''
        if (row.claimedKg === undefined) row.claimedKg = batchKnown ? claimedKg : null
        if (typeof row.holdState !== 'string' || row.holdState === '') row.holdState = '正常'
        if (typeof row.holdReason !== 'string') row.holdReason = ''
        row.legacyUnresolved = !(batchKnown && claimedKg !== null)
        row.revision = ROW_REVISION
      })

      // 其余表补齐行修订号
      for (const table of [tx.table('furnaces'), tx.table('batches'), tx.table('pieces'), tx.table('steps'), tx.table('inspects')]) {
        await table.toCollection().modify((row: Record<string, unknown>) => {
          row.revision = ROW_REVISION
        })
      }
    })
  }
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火与检验记录 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/** 重排时需要的薄数据：退火窑号 + 各作品壁厚 */
async function loadRescheduleContext(): Promise<{ kilnCodes: string[]; wallThicknessOf: (pieceId: string) => number }> {
  const [furnaces, pieces] = await Promise.all([db.furnaces.toArray(), db.pieces.toArray()])
  const kilnCodes = furnaces.filter((row) => row.type === '退火窑').map((row) => row.code).sort()
  const thicknessMap = new Map(pieces.map((row) => [row.id, row.wallThicknessMm]))
  return {
    kilnCodes,
    wallThicknessOf: (pieceId: string): number => thicknessMap.get(pieceId) ?? 4,
  }
}

/** 把一批排位按「作废重排」规则落库（已进窑的排位不动） */
async function applyReschedule(rows: Anneal[]): Promise<RescheduleSummary> {
  if (rows.length === 0) return { invalidated: 0, resumed: 0, waiting: 0, held: 0, details: [] }
  const [batches, allAnneals, { kilnCodes, wallThicknessOf }] = await Promise.all([
    db.batches.toArray(),
    db.anneals.toArray(),
    loadRescheduleContext(),
  ])

  // 障碍只含正常且未出炉的排位；作废目标先整体撤出窑位（快照，不写库）再逐条抢占
  const targets = new Set(rows.map((row) => row.id))
  const staged: Anneal[] = allAnneals.filter((row) => !targets.has(row.id) && occupiesSlot(row))

  // 入窑时间早的先挑空位，尽量贴近原排产顺序
  const ordered = rows.slice().sort((a, b) => a.inAt.localeCompare(b.inAt))
  const outcomes = ordered.map((row) =>
    planReschedule({ row, batches, obstacles: staged, kilnCodes, wallThicknessOf }),
  )

  const stamp = nowIso()
  await db.transaction('rw', db.anneals, async () => {
    for (const outcome of outcomes) {
      await db.anneals.update(outcome.annealId, {
        holdState: outcome.holdState,
        kilnSlot: outcome.kilnSlot,
        holdReason: outcome.reason,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
      if (outcome.holdState === '正常') {
        // 抢到空位的记录立刻成为后续排位的障碍
        const source = ordered.find((row) => row.id === outcome.annealId)
        if (source !== undefined) {
          staged.push({ ...source, holdState: '正常', kilnSlot: outcome.kilnSlot })
        }
      }
    }
  })

  return {
    invalidated: rows.length,
    resumed: outcomes.filter((row) => row.holdState === '正常').length,
    waiting: outcomes.filter((row) => row.holdState === '待排').length,
    held: outcomes.filter((row) => row.holdState === '挂起').length,
    details: outcomes,
  }
}

/**
 * 重新排位：对「待排 / 挂起」的排位再跑一遍对账并由窑务自动找空位。
 * 不传 annealId 时处理全部待排 / 挂起记录。
 */
export async function rescheduleAnneals(annealIds?: string[]): Promise<RescheduleSummary> {
  const all = await db.anneals.toArray()
  const pool = all.filter(
    (row) => row.state === '待入窑' && (row.holdState === '待排' || row.holdState === '挂起'),
  )
  const rows = annealIds === undefined ? pool : pool.filter((row) => annealIds.includes(row.id))
  return applyReschedule(rows)
}

/** 老排位回填确认：熔化工段补齐批次与领用公斤数后，按作废重排规则重新排位 */
export async function resolveLegacyAnneal(
  annealId: string,
  patch: { batchId: string; claimedKg: number },
): Promise<RescheduleSummary | null> {
  const row = await db.anneals.get(annealId)
  if (!row) return null
  await db.anneals.update(annealId, {
    batchId: patch.batchId,
    claimedKg: patch.claimedKg,
    legacyUnresolved: false,
    holdState: '待排',
    kilnSlot: '',
    holdReason: '老排位已回填批次与领用公斤数，等待重新排位',
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
  const refreshed = await db.anneals.get(annealId)
  return refreshed ? applyReschedule([refreshed]) : null
}

/**
 * 熔化工段更正某批「领用公斤数」（直接把台账余量改到目标值）。
 * 用到这批且还没进窑（待入窑）的正常排位一律作废重排；
 * 退火中 / 已出炉的排位照当初认领的量烧完，不动。
 * 补料（余量增加）也走同一入口：无超量风险时作废排位会按原位重新落回。
 */
export async function correctBatchRemain(batchId: string, nextRemainKg: number): Promise<{
  batch: GlassBatch
  deltaKg: number
  reschedule: RescheduleSummary
}> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('料液批次不存在')
  const deltaKg = Math.round((nextRemainKg - batch.remainKg) * 10) / 10
  await db.batches.update(batchId, { remainKg: nextRemainKg, updatedAt: nowIso() })

  const affected = await db.anneals
    .where('batchId')
    .equals(batchId)
    .filter((row) => row.state === '待入窑' && row.holdState === '正常')
    .toArray()

  // 先标记作废（待排不占窑位、不构成障碍）；原窑位保留在内存里供重排时优先回原位
  if (affected.length > 0) {
    const stamp = nowIso()
    await db.anneals.bulkPut(
      affected.map((row) => ({
        ...row,
        holdState: '待排' as HoldState,
        kilnSlot: '',
        holdReason: `熔化工段更正本批领用公斤数（余量变动 ${deltaKg > 0 ? '+' : ''}${deltaKg} kg），原排位作废重排`,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })),
    )
  }

  // 内存行保留原窑位作为重排首选；applyReschedule 会按结果统一覆盖（落不到位则清空）
  const refreshed = affected.map((row) => ({
    ...row,
    holdState: '待排' as HoldState,
    holdReason: '',
  }))
  const summary = await applyReschedule(refreshed)
  return { batch, deltaKg, reschedule: summary }
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), furnaces, batches, pieces, steps, anneals, inspects }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
    await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
    // 兼容旧版存档（v2 及以前的退火记录无对账字段）：缺失字段按待回填处理
    await db.anneals.bulkPut(
      snapshot.anneals.map((row) => ({
        ...row,
        batchId: typeof row.batchId === 'string' ? row.batchId : '',
        claimedKg: typeof row.claimedKg === 'number' ? row.claimedKg : null,
        holdState: row.holdState ?? '正常',
        holdReason: row.holdReason ?? '',
        legacyUnresolved: row.legacyUnresolved ?? typeof row.batchId !== 'string',
        revision: ROW_REVISION,
      })),
    )
    await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
  })
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
  })
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects }
}
