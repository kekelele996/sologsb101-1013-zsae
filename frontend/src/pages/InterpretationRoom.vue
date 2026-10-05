<script setup lang="ts">
/**
 * 模块 7：/interpretations 影像判读室
 * 判读室依据样带照片另判一版覆盖率与白化等级（记判读覆盖率 / 判读等级 / 判读人），
 * 与外业那份各存各的；按样带编号对账：两侧覆盖率差过一成（10 个百分点）挂起等复核，
 * 尚未判读的按外业那份先出并标出；挂起样带重判后自动放行。
 * 落账失败仅重试判读这份（putInterpretationWithRetry），外业数据不受影响。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Camera, RefreshRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ReconcileTag from '@/components/common/ReconcileTag.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useInterpretStore } from '@/stores/interpretStore'
import { useReefStore } from '@/stores/reefStore'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import type { ReconcileRow } from '@/stores/interpretStore'
import type { ReconcileStatus } from '@/types/interpretation'
import { COVERAGE_DIFF_THRESHOLD_PCT, RECONCILE_STATUS_LABEL } from '@/types/interpretation'

const interpretStore = useInterpretStore()
const reefStore = useReefStore()

const statusOptions = (['held', 'pending', 'released', 'matched'] as ReconcileStatus[]).map((value) => ({
  label: RECONCILE_STATUS_LABEL[value],
  value
}))

const dialogVisible = ref(false)
const editingBeltId = ref<string | null>(null)
const editingRow = ref<ReconcileRow | null>(null)
const submitting = ref(false)

const form = reactive({
  coveragePct: 0,
  bleachLevel: '无' as BleachLevel,
  reviewer: '',
  reviewedDate: new Date().toISOString().slice(0, 10),
  remark: ''
})

const rows = computed(() => interpretStore.filteredReconcileRows)

const liveCounts = computed(() => interpretStore.statusCounts)

/** 打开判读弹窗：回显既有判读；挂起样带标题提示这是重判（保存后自动放行） */
function openJudge(row: ReconcileRow): void {
  editingBeltId.value = row.beltId
  editingRow.value = row
  form.coveragePct = row.interpretedCoveragePct ?? row.fieldCoveragePct
  form.bleachLevel = row.interpretedGrade ?? '无'
  form.reviewer = row.interpretation?.reviewer ?? ''
  form.reviewedDate = row.interpretation?.reviewedDate || new Date().toISOString().slice(0, 10)
  form.remark = row.interpretation?.remark ?? ''
  dialogVisible.value = true
}

/** 只有判读室已有正式判读记录才算重判；升级补录的初始值仍按首判处理 */
const isRevise = computed(() => {
  const row = editingRow.value
  return !!row && row.interpretation !== null && !row.isInitial
})

const dialogTitle = computed(() => {
  if (!editingRow.value) return '影像判读'
  const base = `判读样带 ${editingRow.value.beltNo}（${editingRow.value.reefName} · 站位 ${editingRow.value.siteNo}）`
  return isRevise.value ? `重判 · ${base}` : `首判 · ${base}`
})

/** 表单即时差值预览：超过 10 个百分点提示将挂起（重判除外，重判一律放行） */
const previewDiff = computed(() => {
  const field = editingRow.value?.fieldCoveragePct ?? 0
  return Number(Math.abs(Number(form.coveragePct) - field).toFixed(2))
})

const previewWillHold = computed(() => !isRevise.value && previewDiff.value > COVERAGE_DIFF_THRESHOLD_PCT)

async function submitJudge(): Promise<void> {
  if (!editingBeltId.value) return
  const coverage = Number(form.coveragePct)
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 100) {
    ElMessage.warning('判读覆盖率应为 0 ~ 100 之间的数字（%）')
    return
  }
  if (!form.reviewer.trim()) {
    ElMessage.warning('请填写判读人')
    return
  }
  if (!form.reviewedDate) {
    ElMessage.warning('请选择判读日期')
    return
  }
  submitting.value = true
  try {
    const saved = await interpretStore.saveInterpretation(editingBeltId.value, {
      coveragePct: coverage,
      bleachLevel: form.bleachLevel,
      reviewer: form.reviewer,
      reviewedDate: form.reviewedDate,
      remark: form.remark
    })
    dialogVisible.value = false
    if (isRevise.value) {
      ElMessage.success(`样带 ${editingRow.value?.beltNo} 已重判落账，挂起记录自动放行（第 ${saved.revised ? 2 : 1} 版）。`)
    } else if (Math.abs(saved.coveragePct - (editingRow.value?.fieldCoveragePct ?? 0)) > COVERAGE_DIFF_THRESHOLD_PCT) {
      ElMessage.warning(`判读已落账，但与外业覆盖率差 ${Math.abs(saved.coveragePct - (editingRow.value?.fieldCoveragePct ?? 0)).toFixed(2)} 个百分点，该样带已挂起等复核。`)
    } else {
      ElMessage.success(`样带 ${editingRow.value?.beltNo} 判读已落账，两侧对账一致。`)
    }
  } catch {
    // 落账失败：外业那份不受影响，页面顶部错误条提供「只重试判读这份」入口
  } finally {
    submitting.value = false
  }
}

async function retryWrite(): Promise<void> {
  const ok = await interpretStore.retryFailedWrite()
  if (ok) ElMessage.success('判读记录重试落账成功。')
  else ElMessage.error('重试仍失败，请稍后再次重试；外业数据未受影响。')
}

/** 挂起 / 待判读样带整行着色（el-table 行类名） */
function rowClassName({ row }: { row: ReconcileRow }): string {
  return `is-${row.status}`
}

onMounted(() => {
  reefStore.start()
  interpretStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">影像判读室 · 样带照片判读与对账</h2>
        <p class="gb-hint">
          按样带照片另判覆盖率与白化等级（判读覆盖率 / 判读等级 / 判读人），与外业记录各存各的。两侧覆盖率差过
          {{ COVERAGE_DIFF_THRESHOLD_PCT }} 个百分点的样带挂起等复核；判读室尚未判的按外业那份先出并标出；挂起样带重判后自动放行。
        </p>
      </div>
    </div>

    <el-alert v-if="interpretStore.error" type="error" show-icon :closable="false">
      <template #default>
        <div class="page__retry">
          <span>判读记录落账失败：{{ interpretStore.error }}（外业那份不受影响）</span>
          <el-button type="danger" size="small" :icon="RefreshRight" :loading="interpretStore.saving" @click="retryWrite">
            只重试判读这份
          </el-button>
        </div>
      </template>
    </el-alert>

    <div class="gb-stats-row">
      <StatBadge label="样带总数" :value="interpretStore.reconcileRows.length" suffix="条" icon="Files" />
      <StatBadge label="待判读（暂用外业）" :value="liveCounts.pending" suffix="条" tone="warning" icon="Clock" />
      <StatBadge label="挂起等复核" :value="liveCounts.held" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="重判放行" :value="liveCounts.released" suffix="条" tone="info" icon="RefreshRight" />
      <StatBadge label="对账一致" :value="liveCounts.matched" suffix="条" tone="success" icon="CircleCheckFilled" />
    </div>

    <div class="filter-bar page__filter">
      <div class="filter-bar__main">
        <el-input
          :model-value="interpretStore.filter.keyword"
          class="filter-bar__keyword"
          placeholder="搜索礁区 / 站位 / 样带 / 判读人…"
          clearable
          @update:model-value="(value: string) => interpretStore.patchFilter({ keyword: value })"
        />
        <div class="filter-bar__select">
          <span class="filter-bar__label">礁区</span>
          <el-select
            :model-value="interpretStore.filter.reefIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            placeholder="选择礁区"
            class="filter-bar__control"
            @update:model-value="(value: string[]) => interpretStore.patchFilter({ reefIds: value })"
          >
            <el-option v-for="reef in reefStore.reefs" :key="reef.id" :label="reef.name" :value="reef.id" />
          </el-select>
        </div>
        <div class="filter-bar__select">
          <span class="filter-bar__label">对账状态</span>
          <el-select
            :model-value="interpretStore.filter.statuses"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            placeholder="选择状态"
            class="filter-bar__control"
            @update:model-value="(value: ReconcileStatus[]) => interpretStore.patchFilter({ statuses: value })"
          >
            <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </div>
      </div>
      <div class="filter-bar__side">
        <el-button text type="primary" @click="interpretStore.resetFilter()">重置</el-button>
      </div>
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按样带编号对账（{{ rows.length }} 条）</h3>
        <span class="gb-hint">挂起 / 待判读优先排列 · 定稿礁区报告不纳入挂起样带</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="暂无可对账的样带"
        description="请先到样带布设页布设样带并由外业队录入珊瑚覆盖记录，判读室再依据样带照片逐条判读。"
        compact
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact" :row-class-name="rowClassName">
        <el-table-column label="样带编号" min-width="190">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}（{{ row.surveyDate }}）</div>
          </template>
        </el-table-column>
        <el-table-column label="外业覆盖率" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fieldCoveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.fieldCoverCmTotal }} cm / {{ row.lengthM }} m</div>
          </template>
        </el-table-column>
        <el-table-column label="判读覆盖率" width="130" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'pending'" size="small" type="warning" effect="plain">
              {{ row.isInitial ? '初始值' : '未判读' }}
            </el-tag>
            <span v-else class="gb-mono">{{ row.interpretedCoveragePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="判读等级" width="100" align="center">
          <template #default="{ row }">
            <BleachTag v-if="row.status !== 'pending' && row.interpretedGrade" :level="row.interpretedGrade" size="small" :icon="false" />
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="差值" width="100" align="right">
          <template #default="{ row }">
            <span
              v-if="row.status !== 'pending' && row.coverageDiffPct !== null"
              class="gb-mono"
              :class="{ 'page__diff-danger': row.coverageDiffPct > COVERAGE_DIFF_THRESHOLD_PCT }"
            >
              {{ row.coverageDiffPct }} 点
            </span>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="对账状态" width="120" align="center">
          <template #default="{ row }">
            <ReconcileTag :status="row.status" size="small" />
            <el-tag v-if="row.isInitial" size="small" type="info" effect="plain" class="page__initial">初始值</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="判读人 / 日期" min-width="150">
          <template #default="{ row }">
            <div v-if="row.interpretation" class="gb-mono">
              {{ row.reviewer || '未署名' }}
              <el-tag v-if="row.interpretation.source === 'initial'" size="small" type="info" effect="plain">升级补录</el-tag>
            </div>
            <div v-if="row.interpretation" class="gb-hint">{{ row.interpretation.reviewedDate || '日期未填' }}</div>
            <span v-else class="gb-hint">判读室尚未判，结论暂用外业</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" size="small" :icon="Camera" @click="openJudge(row)">
              {{ row.interpretation ? '重判' : '判读' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="460px" destroy-on-close>
      <el-alert
        v-if="isRevise"
        type="success"
        :closable="false"
        show-icon
        title="本次为重判：保存后该样带（含挂起中）自动放行，计入定稿礁区报告。"
        class="page__dialog-alert"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        :title="`首判将与外业覆盖率 ${editingRow?.fieldCoveragePct}% 对账，差过 ${COVERAGE_DIFF_THRESHOLD_PCT} 个百分点会挂起等复核。`"
        class="page__dialog-alert"
      />
      <el-form label-width="96px">
        <el-form-item label="外业覆盖率">
          <span class="gb-mono">{{ editingRow?.fieldCoveragePct }}%（{{ editingRow?.fieldCoverCmTotal }} cm / {{ editingRow?.lengthM }} m）</span>
        </el-form-item>
        <el-form-item label="判读覆盖率">
          <el-input-number v-model="form.coveragePct" :min="0" :max="100" :precision="2" :step="1" controls-position="right" />
          <span class="gb-hint" :class="{ 'page__diff-danger': previewWillHold }">
            与外业差 {{ previewDiff }} 个百分点
            <template v-if="previewWillHold">，保存后将挂起等复核</template>
          </span>
        </el-form-item>
        <el-form-item label="判读等级">
          <el-radio-group v-model="form.bleachLevel">
            <el-radio v-for="level in BLEACH_LEVELS" :key="level" :value="level">{{ level }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="判读人">
          <el-input v-model="form.reviewer" placeholder="如 苏映雪" maxlength="20" show-word-limit />
        </el-form-item>
        <el-form-item label="判读日期">
          <el-date-picker v-model="form.reviewedDate" type="date" value-format="YYYY-MM-DD" placeholder="选择判读日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="照片批次、判读疑点等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitJudge">
          {{ isRevise ? '提交重判（自动放行）' : '提交判读' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__filter {
  padding: 12px 16px;
}

.page__retry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page__diff-danger {
  color: #b03a2e;
  font-weight: 700;
}

.page__initial {
  margin-left: 4px;
}

.page__dialog-alert {
  margin-bottom: 12px;
}

:deep(.el-table .is-held) {
  background-color: #fdecea !important;
}

:deep(.el-table .is-pending) {
  background-color: #fdf8ec;
}
</style>
