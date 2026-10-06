<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排（两账对账）
 * 排位前先认作品取料的批次与领用公斤数，与熔化工段料液台账按批次对账：
 * 批次对不上或领用量超余量 → 这一炉挂起、不占窑位。
 * 窑位时间窗冲突时禁用提交；挂起可在熔化确认后重新对账，窑务自动找回空位；出炉回写作品状态。
 * 消费模型：Anneal、Piece、GlassBatch、Furnace；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  CURVE_SEG_OPTIONS,
  isFrozenState,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type CurveSeg,
} from '@/types/anneal'
import { ANNEAL_CURVE, formatHours, segmentHours, totalAnnealHours } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<AnnealDraft>({
  pieceId: '',
  batchId: '',
  drawKg: 5,
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  batchId: [{ required: true, message: '请确认取料批次', trigger: 'change' }],
  drawKg: [{ required: true, message: '请填写领用公斤数', trigger: 'blur' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
}

/** 筛选下拉只展示可排位的三种状态，挂起 / 待排单列卡片 */
const STATE_FILTER_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉', '挂起', '待排']

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

/** 选中作品后，批次默认取作品挂的批次 */
watch(
  () => form.pieceId,
  (pieceId) => {
    if (editingId.value !== null) return
    const piece = pieceStore.pieces.find((row) => row.id === pieceId)
    if (piece !== undefined && form.batchId !== piece.batchId) form.batchId = piece.batchId
  },
)

const slotOptions = computed<string[]>(() => {
  const codes = furnaceStore.annealingFurnaces.map((row) => row.code)
  if (codes.length === 0) return annealStore.allSlots
  const list: string[] = []
  codes.forEach((code) => {
    for (let index = 0; index < 9; index += 1) {
      const row = String.fromCharCode(65 + Math.floor(index / 3))
      list.push(`${code}-${row}${(index % 3) + 1}`)
    }
  })
  return list
})

/** 表单实时对账结果 */
const reconcile = computed(() =>
  annealStore.reconcileOf({ pieceId: form.pieceId, batchId: form.batchId, drawKg: form.drawKg })
)

/** 当前表单的窑位冲突检测结果（挂起时不占窑位、不判冲突） */
const conflict = computed(() => {
  if (!reconcile.value.ok) return { conflict: false, withPieceId: '', withAnnealId: '', message: '' }
  return annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    curveSeg: form.curveSeg,
    pieceId: form.pieceId,
    state: '待入窑',
  })
})

/** 编辑的是否为已进窑记录（批次 / 领用量冻结） */
const editingFrozen = computed<boolean>(() => {
  if (editingId.value === null) return false
  const row = annealStore.anneals.find((item) => item.id === editingId.value)
  return row !== undefined && isFrozenState(row.state)
})

const formDuration = computed(() => {
  const piece = pieceStore.pieces.find((row) => row.id === form.pieceId)
  const thickness = piece?.wallThicknessMm ?? 4
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
  }
})

const stats = computed(() => ({
  total: annealStore.anneals.length,
  waiting: annealStore.anneals.filter((row) => row.state === '待入窑').length,
  held: annealStore.anneals.filter((row) => row.state === '挂起').length,
  queued: annealStore.anneals.filter((row) => row.state === '待排').length,
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  const firstPieceId = pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? ''
  const piece = pieceStore.pieces.find((row) => row.id === firstPieceId)
  Object.assign(form, {
    pieceId: firstPieceId,
    batchId: piece?.batchId ?? '',
    drawKg: 5,
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    batchId: row.batchId,
    drawKg: row.drawKg,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (conflict.value.conflict) {
    ElMessage.error(conflict.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(row.state === '挂起' ? '这一炉已挂起，不占窑位' : `已分配窑位 ${row.kilnSlot}`)
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot} 的退火记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火记录已删除')
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info(annealStore.lastMessage)
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

async function handleRecheck(row: Anneal): Promise<void> {
  const next = await annealStore.recheck(row.id)
  if (next === null) return
  ElMessage.success(annealStore.lastMessage)
}

async function handleRerankAll(): Promise<void> {
  const count = stats.value.held + stats.value.queued
  if (count === 0) {
    ElMessage.info('没有挂起或待排的排位需要重排。')
    return
  }
  const { placed, held, queued } = await annealStore.rerankAll()
  ElMessage.success(`重排完成：落位 ${placed}、挂起 ${held}、待排 ${queued}`)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}

/** 表格状态标签色 */
function tagType(state: AnnealState): 'info' | 'danger' | 'warning' | 'success' | 'primary' {
  return annealStore.annealStateTagType(state)
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="挂起" :value="stats.held" suffix="条" :tone="stats.held > 0 ? 'danger' : 'success'" icon="Warning" />
      <StatBadge label="待排" :value="stats.queued" suffix="条" :tone="stats.queued > 0 ? 'warning' : 'success'" icon="Timer" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位（挂起/待排不占）`"
      />
    </div>

    <el-alert
      v-if="stats.held + stats.queued > 0"
      :type="stats.held > 0 ? 'error' : 'warning'"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${stats.held} 条挂起（批次/公斤待熔化工段确认）、${stats.queued} 条待排（等空位），均不占窑位`"
    >
      <template #default>
        <div class="hold-list">
          <div v-for="row in [...annealStore.heldAnneals, ...annealStore.queuedAnneals]" :key="row.id">
            {{ pieceName[row.pieceId] ?? '（作品已删除）' }} ·
            {{ annealStore.batchColorOf(row.batchId) || '批次待核' }} · 领用 {{ row.drawKg }} kg ·
            <el-tag size="small" :type="tagType(row.state)">{{ row.state }}</el-tag>
            <span class="hold-reason">—— {{ row.holdReason }}</span>
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-space>
            <el-button
              :disabled="stats.held + stats.queued === 0"
              :loading="submitting"
              @click="handleRerankAll"
            >
              一键重排挂起/待排
            </el-button>
            <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0">
              <el-icon><Plus /></el-icon>
              <span>分配窑位</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: STATE_FILTER_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火编排"
        description="为已完成全部工序的作品分配退火窑位与曲线段；排位前先按批次对账，批次对不上或领用量超余量会挂起不占窑位，同窑位时间窗重叠会禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                {{ annealStore.durationOf(row.pieceId).text }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="对账批次 / 领用" min-width="160">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">
                {{ annealStore.batchColorOf(row.batchId) || '批次待核' }}
              </span>
              <span class="cell-sub">
                领用 {{ row.drawKg }} kg
                <template v-if="annealStore.pieceBatchOf(row.pieceId) !== row.batchId">
                  · <span class="cell-warn">与作品批次不符</span>
                </template>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="130">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="120">
          <template #default="{ row }">
            <span :class="{ 'cell-sub': row.state === '挂起' || row.state === '待排' }">
              {{ row.kilnSlot }}
              <span v-if="row.state === '挂起' || row.state === '待排'">（意向）</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="曲线段" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'"
            >
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="150">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="状态 / 原因" min-width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-tag size="small" :type="tagType(row.state)" effect="dark">{{ row.state }}</el-tag>
              <el-tooltip v-if="row.holdReason !== ''" :content="row.holdReason" placement="top">
                <span class="hold-reason">{{ row.holdReason }}</span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.state === '挂起' || row.state === '待排'"
              link
              type="success"
              size="small"
              @click="handleRecheck(row)"
            >
              重新对账
            </el-button>
            <el-button
              link
              type="primary"
              size="small"
              :disabled="row.state !== '待入窑'"
              @click="handleAdvance(row)"
            >
              推进状态
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表（挂起 / 待排不占窑位）</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{ 'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied) }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template
            v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot && item.occupied)"
            :key="row.annealId"
          >
            <div class="slot-detail">
              {{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}
            </div>
          </template>
          <div
            v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot && item.occupied).length === 0"
            class="slot-detail is-free"
          >
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '分配退火窑位' : '编辑退火编排'" width="680px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select
                v-model="form.pieceId"
                filterable
                style="width: 100%"
                :disabled="editingFrozen"
              >
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="取料批次" prop="batchId">
              <el-select
                v-model="form.batchId"
                filterable
                style="width: 100%"
                :disabled="editingFrozen"
              >
                <el-option
                  v-for="item in furnaceStore.batches"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.colorCode} · ${item.recipe} · 余 ${item.remainKg} kg`"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="领用量（kg）" prop="drawKg">
              <el-input-number
                v-model="form.drawKg"
                :min="0.5"
                :max="5000"
                :step="0.5"
                style="width: 100%"
                :disabled="editingFrozen"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="退火窑位" prop="kilnSlot">
              <el-select v-model="form.kilnSlot" filterable style="width: 100%">
                <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="入窑时间" prop="inAt">
              <el-date-picker
                v-model="form.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="出炉时间">
              <el-date-picker
                v-model="form.outAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                placeholder="未出炉可留空"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          v-if="editingFrozen"
          type="info"
          show-icon
          :closable="false"
          title="该排位已进窑，批次与领用量照当初快照冻结"
          description="已进窑 / 已出炉的作品按当初认领的批次与公斤数烧完，改料或改配方不影响它。"
          class="mb-14"
        />
        <el-alert
          v-else-if="!reconcile.ok"
          type="error"
          show-icon
          :closable="false"
          title="两账对账不通过：这一炉将挂起，不占窑位"
          :description="reconcile.reason"
        />
        <el-alert v-else-if="conflict.conflict" type="error" show-icon :closable="false" title="窑位冲突，无法提交" :description="conflict.message" />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="对账通过、窑位可用，可以提交"
          :description="`当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，该作品全流程退火 ${formDuration.total}。${formDuration.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!editingFrozen && conflict.conflict"
          @click="handleSubmit"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-strong {
  font-weight: 600;
  color: #1d2b3a;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.hold-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.hold-reason {
  font-size: 12px;
  color: #c0392b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
  display: inline-block;
  vertical-align: middle;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
