<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 排位前与熔化工段料液台账按批次号对账：批次对不上 / 领用超余量 → 挂起不占窑位；
 * 窑位冲突时禁用提交；出炉即回写作品状态为「已退火」。
 * 熔化工段更正领用公斤数后未进窑排位作废，由本页「重新排位」自动找空位。
 * 消费模型：Anneal、Piece、Furnace、GlassBatch、Step；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  HOLD_STATE_OPTIONS,
  ANNEAL_STATE_OPTIONS,
  CURVE_SEG_OPTIONS,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type CurveSeg,
  type HoldState,
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
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
  batchId: '',
  claimedKg: 5,
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
  state: [{ required: true, message: '请选择退火状态', trigger: 'change' }],
  batchId: [{ required: true, message: '请确认取料批次', trigger: 'change' }],
  claimedKg: [{ required: true, message: '请填写领用公斤数', trigger: 'change' }],
}

/** 老排位回填弹窗 */
const legacyDialogVisible = ref(false)
const legacyTarget = ref<Anneal | null>(null)
const legacyForm = reactive<{ batchId: string; claimedKg: number }>({ batchId: '', claimedKg: 5 })

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
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

/** 当前表单的对账结果：批次对不上 / 领用超余量时挂起，不占窑位 */
const reconcile = computed(() =>
  form.batchId === '' || !(form.claimedKg > 0)
    ? null
    : annealStore.reconcileOf(form.batchId, form.claimedKg, editingId.value ?? '')
)

/** 当前表单的窑位冲突检测结果（仅对账通过时才占窑位、才需要判冲突） */
const conflict = computed(() =>
  reconcile.value?.ok === true
    ? annealStore.conflictOf({
        id: editingId.value ?? '',
        kilnSlot: form.kilnSlot,
        inAt: form.inAt,
        outAt: form.outAt,
        curveSeg: form.curveSeg,
        pieceId: form.pieceId,
      })
    : { conflict: false, withPieceId: '', withAnnealId: '', message: '' }
)

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
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
  held: annealStore.heldAnneals.length,
  queued: annealStore.waitingAnneals.length,
  legacy: annealStore.legacyAnneals.length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function pieceBatchId(pieceId: string): string {
  return pieceStore.pieces.find((row) => row.id === pieceId)?.batchId ?? ''
}

function syncFormBatch(): void {
  // 排位认的是作品取料批次；改作品时带过批次与默认领用公斤数
  const expected = pieceBatchId(form.pieceId)
  if (expected !== '') form.batchId = expected
  form.claimedKg = annealStore.defaultClaimedKg(form.pieceId)
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
    batchId: '',
    claimedKg: 5,
  })
  syncFormBatch()
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot === '' ? slotOptions.value[0] ?? 'AN-01-A1' : row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
    batchId: row.batchId,
    claimedKg: row.claimedKg ?? annealStore.defaultClaimedKg(row.pieceId),
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
      if (reconcile.value?.ok === false) {        try {
          await ElMessageBox.confirm(
            `对账不过：${reconcile.value.reason}。这一炉将挂起、不占窑位，退回熔化工段确认后再重新排位。`,
            '确认挂起这一炉？',
            { type: 'warning', confirmButtonText: '挂起保存', cancelButtonText: '取消' },
          )
        } catch {
          return
        }
      }
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(row.holdState === '挂起' ? '已挂起，不占窑位' : `已分配窑位 ${row.kilnSlot}`)
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
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot || '（未占窑位）'} 的退火记录？`, '删除确认', {
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
    ElMessage.info('该记录已处于「已出炉」状态')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

/** 重新排位（窑务自动找空位）；支持单条或全部 */
async function handleReschedule(row?: Anneal): Promise<void> {
  const result = await annealStore.reschedule(row === undefined ? undefined : [row.id])
  if (result.resumed > 0) ElMessage.success(annealStore.lastMessage)
  else ElMessage.warning(annealStore.lastMessage)
}

function openLegacy(row: Anneal): void {
  legacyTarget.value = row
  const expected = pieceBatchId(row.pieceId)
  legacyForm.batchId = row.batchId !== '' ? row.batchId : expected
  legacyForm.claimedKg = row.claimedKg ?? annealStore.defaultClaimedKg(row.pieceId)
  legacyDialogVisible.value = true
}

async function submitLegacy(): Promise<void> {
  const target = legacyTarget.value
  if (target === null) return
  if (legacyForm.batchId === '' || !(legacyForm.claimedKg > 0)) {
    ElMessage.error('请回填取料批次与领用公斤数')
    return
  }
  const ok = await annealStore.resolveLegacy(target.id, { ...legacyForm })
  legacyDialogVisible.value = false
  ElMessage[ok ? 'success' : 'warning'](annealStore.lastMessage)
}

function holdTagType(holdState: HoldState): 'success' | 'warning' | 'danger' {
  if (holdState === '挂起') return 'danger'
  if (holdState === '待排') return 'warning'
  return 'success'
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
  if (key === 'holdState') annealStore.setFilters({ holdState: value as HoldState | 'all' })
}

/** 挂起 / 待排 / 老排位待回填队列（不随状态筛选隐藏） */
const queueRows = computed<Anneal[]>(() =>
  annealStore.anneals
    .filter((row) => row.holdState !== '正常' || row.legacyUnresolved)
    .sort((a, b) => a.inAt.localeCompare(b.inAt))
)
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge
        label="对账挂起"
        :value="stats.held"
        suffix="炉"
        :tone="stats.held > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="批次对不上 / 领用超余量，不占窑位，等熔化确认"
      />
      <StatBadge
        label="作废待排"
        :value="stats.queued"
        suffix="条"
        :tone="stats.queued > 0 ? 'warning' : 'success'"
        icon="Clock"
        hint="领用更正后作废重排，暂无空窑位"
      />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位（挂起/待排不占窑位）`"
      />
    </div>

    <el-alert
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <el-card v-if="queueRows.length > 0" shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">
            挂起 / 待排队列（{{ queueRows.length }} 条，不占窑位）
          </span>
          <el-button type="primary" plain @click="handleReschedule()">
            全部重新排位（窑务找空位）
          </el-button>
        </div>
      </template>
      <el-table :data="queueRows" row-key="id" stripe size="small">
        <el-table-column label="作品" min-width="170">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
              {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="批次色号" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="row.batchId === '' ? 'danger' : 'info'">
              {{ annealStore.colorCodeOf(row.batchId) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="认领量" width="100" align="right">
          <template #default="{ row }">{{ row.claimedKg === null ? '待回填' : `${row.claimedKg} kg` }}</template>
        </el-table-column>
        <el-table-column label="排位状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="holdTagType(row.holdState)" effect="dark">{{ row.holdState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="280">
          <template #default="{ row }">
            <span class="cell-sub">{{ row.holdReason || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.legacyUnresolved"
              link
              type="warning"
              size="small"
              @click="openLegacy(row)"
            >
              回填确认
            </el-button>
            <el-button link type="primary" size="small" @click="handleReschedule(row)">重新排位</el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0">
            <el-icon><Plus /></el-icon>
            <span>分配窑位</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'holdState', label: '排位状态', options: HOLD_STATE_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          holdState: annealStore.filters.holdState,
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
        description="排位前先认作品取料批次与领用公斤数：批次对不上或领用超余量会挂起且不占窑位；同一窑位时间窗重叠时禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
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
        <el-table-column label="批次 / 认领量" width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-tag size="small" :type="row.batchId === '' ? 'danger' : 'info'">
                {{ annealStore.colorCodeOf(row.batchId) }}
              </el-tag>
              <span class="cell-sub">{{ row.claimedKg === null ? '领用公斤数待回填' : `认领 ${row.claimedKg} kg` }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="排位" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="holdTagType(row.holdState)">{{ row.holdState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="窑位" width="120">
          <template #default="{ row }">
            <span v-if="row.kilnSlot === ''" class="cell-sub">不占窑位</span>
            <span v-else>{{ row.kilnSlot }}</span>
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
        <el-table-column label="该段时长" width="110" align="right">
          <template #default="{ row }">
            {{ formatHours(segmentHours(row.curveSeg, annealStore.wallThicknessOf(row.pieceId))) }}
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="150">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="出炉时间" width="150">
          <template #default="{ row }">
            <span v-if="row.outAt === ''" class="cell-sub">未出炉</span>
            <span v-else>{{ row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="row.state === '已出炉' || row.holdState !== '正常'"
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
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.annealId">
            <div class="slot-detail">
              {{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
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
              <el-select v-model="form.pieceId" filterable style="width: 100%" @change="syncFormBatch">
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
              <el-select v-model="form.batchId" filterable style="width: 100%">
                <el-option
                  v-for="item in furnaceStore.batches"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.colorCode} · 余 ${item.remainKg} kg · ${item.recipe}`"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="领用公斤数" prop="claimedKg">
              <el-input-number v-model="form.claimedKg" :min="0.5" :max="5000" :step="0.5" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="退火窑位" prop="kilnSlot">
              <el-select
                v-model="form.kilnSlot"
                filterable
                style="width: 100%"
                :disabled="reconcile?.ok === false"
              >
                <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
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
        <el-form-item label="退火状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ANNEAL_STATE_OPTIONS" :key="item" :value="item" :label="item" />
          </el-select>
        </el-form-item>

        <el-alert
          v-if="reconcile?.ok === false"
          type="error"
          show-icon
          :closable="false"
          title="对账不过：这一炉保存后将挂起，不占窑位"
          :description="reconcile.reason"
        />
        <el-alert
          v-else-if="conflict.conflict"
          type="error"
          show-icon
          :closable="false"
          title="窑位冲突，无法提交"
          :description="conflict.message"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="对账通过，窑位可用，可以提交"
          :description="`${reconcile?.batch?.colorCode ?? ''} 批次可用余量 ${reconcile?.availableKg ?? 0} kg；当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，该作品全流程退火 ${formDuration.total}。${formDuration.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="conflict.conflict"
          @click="handleSubmit"
        >
          {{ reconcile?.ok === false ? '挂起保存（不占窑位）' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="legacyDialogVisible" title="老排位回填：批次与领用公斤数" width="520px">
      <p class="dialog-tip">
        老排位原本没记批次，按作品挂的批次回填：
        <b>{{ legacyTarget ? (pieceName[legacyTarget.pieceId] ?? '（作品已删除）') : '' }}</b>
        。回填保存后立即按当前台账重新对账并由窑务找空位重排。
      </p>
      <el-form label-width="120px">
        <el-form-item label="取料批次" required>
          <el-select v-model="legacyForm.batchId" filterable style="width: 100%">
            <el-option
              v-for="item in furnaceStore.batches"
              :key="item.id"
              :value="item.id"
              :label="`${item.colorCode} · 余 ${item.remainKg} kg`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="领用公斤数" required>
          <el-input-number v-model="legacyForm.claimedKg" :min="0.5" :max="5000" :step="0.5" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="legacyDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitLegacy">回填并重新排位</el-button>
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

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.dialog-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: #5b6b7a;
  line-height: 1.7;
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
