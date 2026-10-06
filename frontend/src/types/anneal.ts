/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 *
 * 两本台账（熔化工段料液台账 / 窑务排位台账）按批次号对账：
 * 排位快照记录所用批次与领用公斤数；批次对不上或领用超过批次可用余量时挂起，不占窑位。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

/**
 * 排位状态（与退火进度正交）：
 * - 正常：对账通过且已占窑位
 * - 待排：已作废重排，暂未占到窑位（不占窑位，等窑务重新排位）
 * - 挂起：批次对不上 / 领用超余量，不占窑位，退回熔化工段确认
 */
export type HoldState = '正常' | '待排' | '挂起'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']
export const HOLD_STATE_OPTIONS: HoldState[] = ['正常', '待排', '挂起']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1；待排 / 挂起时为空串（不占窑位） */
  kilnSlot: string
  /** 曲线段 */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 排位时对账用的批次快照（按作品挂的批次回填；老排位填不出为空串） */
  batchId: string
  /** 排位时认账的领用公斤数快照；老排位回填不出为 null（单列待确认） */
  claimedKg: number | null
  /** 排位状态：正常 / 待排 / 挂起 */
  holdState: HoldState
  /** 挂起 / 待排原因（对账失败说明或无空位说明） */
  holdReason: string
  /** 老排位升级回填不出批次/领用公斤数：true 时进入「老排位待回填」单列 */
  legacyUnresolved: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿 */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 对账批次（默认带作品挂的批次，允许窑务排位时改认） */
  batchId: string
  /** 领用公斤数 */
  claimedKg: number
}
