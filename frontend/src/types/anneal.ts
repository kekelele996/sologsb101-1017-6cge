/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；排位前先与熔化工段料液台账按批次对账：
 * 批次对不上或领用公斤数超过余量 → 挂起，不占窑位。
 * 窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/**
 * 退火状态：
 * - 待入窑：对账通过、已排位但尚未进窑（占窑位，可被改批作废重排）
 * - 挂起：批次对不上或领用量超余量，不占窑位，等熔化工段确认
 * - 待排：原排位作废后撤回，等窑务找回空位（不占窑位）
 * - 退火中：已进窑，照当初领的量烧完，批次/领用量快照冻结
 * - 已出炉：已完成，快照冻结
 */
export type AnnealState = '待入窑' | '挂起' | '待排' | '退火中' | '已出炉'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '挂起', '待排', '退火中', '已出炉']

/** 状态推进顺序（仅推进按钮使用；挂起 / 待排不参与顺序推进） */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 占用窑位的状态：只有已排位且未进窑、以及已进窑的记录占窑位 */
export const SLOT_OCCUPYING_STATES: AnnealState[] = ['待入窑', '退火中']

/** 已进窑：批次与领用公斤数照当初快照烧完，不再重算、不可改 */
export const FROZEN_STATES: AnnealState[] = ['退火中', '已出炉']

/** 未进窑、排位可被作废重排的状态 */
export const OPEN_STATES: AnnealState[] = ['待入窑', '挂起', '待排']

/** 判断某状态是否占用窑位 */
export function occupiesSlot(state: AnnealState): boolean {
  return SLOT_OCCUPYING_STATES.includes(state)
}

/** 判断某状态的批次 / 领用量是否已随进窑冻结 */
export function isFrozenState(state: AnnealState): boolean {
  return FROZEN_STATES.includes(state)
}

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 排位时认领用的料液批次（窑务账，对账依据） */
  batchId: string
  /** 排位时认领用的公斤数（窑务账，对账依据；进窑后冻结） */
  drawKg: number
  /** 退火窑号 + 窑位，如 AN-01-A1；挂起 / 待排时为意向窑位，不占窑位 */
  kilnSlot: string
  /** 曲线段 */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 挂起 / 待排原因（对账失败说明、作废重排说明），正常排位为空串 */
  holdReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿 */
export interface AnnealDraft {
  pieceId: string
  batchId: string
  drawKg: number
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
}
