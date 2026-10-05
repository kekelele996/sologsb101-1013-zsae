<script setup lang="ts">
/**
 * 模块 6：/coverage 白化等级评定与覆盖度汇总
 * 汇总各样带的珊瑚覆盖率、白化指数与鱼类密度；查看结构版本并导入导出全量 JSON。
 * 复用 <BleachTag>、<FilterBar>。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToArray, queryToBool } from '@/types/filter'
import BleachTag from '@/components/common/BleachTag.vue'
import ReconcileTag from '@/components/common/ReconcileTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useInterpretStore } from '@/stores/interpretStore'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import { COVERAGE_DIFF_THRESHOLD_PCT } from '@/types/interpretation'
import { BLEACH_COLOR } from '@/utils/bleach'
import {
  DB_NAME,
  DB_VERSION,
  countAll,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  type BackupPayload
} from '@/utils/db'
import {
  countPayload,
  exportBackupJson,
  importBackup,
  readFileText,
  remapIds,
  validateBackup,
  type CountMap
} from '@/utils/export'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const surveyStore = useSurveyStore()
const interpretStore = useInterpretStore()

const EMPTY_COUNTS: CountMap = {
  reefs: 0,
  sites: 0,
  belts: 0,
  corals: 0,
  fishes: 0,
  interpretations: 0
}

const counts = ref<CountMap>(EMPTY_COUNTS)
const lastBackupAt = ref<string | null>(null)
const stampedVersion = ref<number>(DB_VERSION)
const overwriteOnImport = ref(true)
const fileList = ref<UploadFile[]>([])
const busy = ref(false)
const notice = ref('')

const filterModel = computed<FilterModel>(() => ({
  keyword: surveyStore.filter.keyword,
  reefIds: surveyStore.filter.reefIds,
  bleachLevels: surveyStore.filter.bleachLevels
}))

/**
 * 汇总主表：以影像判读室的对账台账为同一口径（外业覆盖率 + 判读覆盖率 + 对账状态），
 * 再叠加覆盖度页原有的关键字 / 礁区 / 白化等级 / 仅看白化筛选。
 */
const allRows = computed(() => interpretStore.reconcileRows)

const rows = computed(() =>
  allRows.value.filter((row) => {
    const filterState = surveyStore.filter
    const keyword = filterState.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}${row.reviewer ?? ''}`
      if (!haystack.includes(keyword)) return false
    }
    if (filterState.reefIds.length > 0 && !filterState.reefIds.includes(row.reefId)) return false
    if (filterState.bleachLevels.length > 0) {
      const matched = filterState.bleachLevels.some((level) => row.distribution[level] > 0)
      if (!matched) return false
    }
    if (filterState.onlyBleached && row.bleachedSharePct <= 0) return false
    return true
  })
)

/** 计入定稿结论的样带（排除挂起等复核） */
const conclusiveRows = computed(() => rows.value.filter((row) => row.conclusive))

const totals = computed(() => {
  const basis = conclusiveRows.value
  return {
    belts: rows.value.length,
    conclusiveBelts: basis.length,
    heldBelts: rows.value.filter((row) => row.status === 'held').length,
    pendingBelts: rows.value.filter((row) => row.status === 'pending').length,
    coralCount: basis.reduce((sum, row) => sum + row.coralCount, 0),
    coverCmTotal: basis.reduce((sum, row) => sum + row.fieldCoverCmTotal, 0),
    fishTotal: basis.reduce((sum, row) => sum + row.fishTotal, 0),
    avgCoveragePct:
      basis.length === 0
        ? 0
        : Number((basis.reduce((sum, row) => sum + row.fieldCoveragePct, 0) / basis.length).toFixed(2)),
    avgBleachIndex:
      basis.length === 0
        ? 0
        : Number((basis.reduce((sum, row) => sum + row.bleachIndex, 0) / basis.length).toFixed(2)),
    bleachedBelts: basis.filter((row) => row.bleachedSharePct > 0).length
  }
})

/** 当前筛选结果内的白化等级分布 */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = Number(rows.value.reduce((sum, row) => sum + row.distribution[level], 0).toFixed(1))
  })
  return result
})

const distributionTotal = computed(() =>
  BLEACH_LEVELS.reduce((sum, level) => sum + distribution.value[level], 0)
)

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

/** 挂起 / 待判读样带整行着色（el-table 行类名） */
function rowClassName({ row }: { row: { status: string } }): string {
  return `is-${row.status}`
}

async function refresh(): Promise<void> {
  counts.value = (await countAll()) as CountMap
  lastBackupAt.value = readLastBackupAt()
  stampedVersion.value = readStampedDbVersion()
}

function handleFilterChange(): void {
  void router.replace({
    query: buildQuery({
      kw: surveyStore.filter.keyword,
      reef: surveyStore.filter.reefIds,
      level: surveyStore.filter.bleachLevels,
      bleached: surveyStore.filter.onlyBleached
    })
  })
}

function handleReset(): void {
  surveyStore.resetFilter()
  void router.replace({ query: {} })
}

async function handleExport(): Promise<void> {
  busy.value = true
  try {
    const result = await exportBackupJson()
    await refresh()
    notice.value = `已导出 ${result.fileName}（共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录）。`
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
  }
}

async function handleImport(): Promise<void> {
  const file = fileList.value[0]?.raw
  if (!file) {
    ElMessage.warning('请先选择备份 JSON 文件')
    return
  }
  busy.value = true
  try {
    const text = await readFileText(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      ElMessage.error('文件不是合法的 JSON，无法解析')
      return
    }
    const validation = validateBackup(parsed)
    if (!validation.ok || !validation.payload) {
      ElMessage.error(`备份校验失败：${validation.errors.join('；')}`)
      return
    }
    const payload: BackupPayload = overwriteOnImport.value ? validation.payload : remapIds(validation.payload)
    const summary = countPayload(payload)
    await ElMessageBox.confirm(
      `将导入 ${Object.entries(summary)
        .map(([key, value]) => `${key} ${value} 条`)
        .join('、')}；${overwriteOnImport.value ? '覆盖模式会先清空现有本地数据' : '追加模式会重新分配 id 保留现有数据'}。确认继续？`,
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importBackup(payload, overwriteOnImport.value)
    await refresh()
    notice.value = '导入完成，覆盖度汇总已刷新。'
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
    fileList.value = []
  }
}

async function handleDatabaseReset(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空全部本地数据并重新播种演示数据（礁区、站位、样带、珊瑚记录、鱼类计数）。确认继续？',
      '重置本地数据',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  notice.value = '本地数据已重置为演示数据。'
  ElMessage.success(notice.value)
}

async function copySummary(): Promise<void> {
  const text = conclusiveRows.value
    .map((row) => {
      const reconcileNote =
        row.status === 'pending'
          ? '【判读室未判，暂按外业】'
          : row.status === 'released'
            ? '【重判放行】'
            : ''
      return (
        `${row.reefName}｜站位 ${row.siteNo}｜样带 ${row.beltNo}（${row.orientation}向 ${row.lengthM} m）：` +
        `外业覆盖率 ${row.fieldCoveragePct}%${
          row.interpretedCoveragePct === null ? '' : `，判读覆盖率 ${row.interpretedCoveragePct}%（差 ${row.coverageDiffPct} 点）`
        }，白化指数 ${row.bleachIndex}（${row.fieldGrade}），白化占比 ${row.bleachedSharePct}%，` +
        `鱼类 ${row.fishTotal} 尾（${row.fishDensityValue} 尾/100m²）${reconcileNote}`
      )
    })
    .join('\n')
  const held = rows.value.filter((row) => row.status === 'held')
  const heldNote = held.length > 0 ? `\n另有 ${held.length} 条样带两侧差过 ${COVERAGE_DIFF_THRESHOLD_PCT} 点挂起等复核，未计入本结论。` : ''
  try {
    await navigator.clipboard.writeText(`${text}${heldNote}`)
    notice.value = heldNote ? '定稿结论已复制（挂起样带已剔除并附说明）。' : '覆盖度结论已复制到剪贴板。'
    ElMessage.success(notice.value)
  } catch {
    notice.value = '当前浏览器不允许读取剪贴板，请手动选中表格内容复制。'
    ElMessage.warning(notice.value)
  }
}

onMounted(() => {
  reefStore.start()
  interpretStore.start()
  surveyStore.patchFilter({
    keyword: typeof route.query.kw === 'string' ? route.query.kw : '',
    reefIds: queryToArray(route.query.reef),
    bleachLevels: queryToArray(route.query.level) as BleachLevel[],
    onlyBleached: queryToBool(route.query.bleached)
  })
  void refresh()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">白化等级评定与覆盖度汇总</h2>
        <p class="gb-hint">
          按样带编号对外业覆盖率与影像判读室判读覆盖率：差过 {{ COVERAGE_DIFF_THRESHOLD_PCT }} 个百分点挂起等复核（不计入定稿），判读室未判的暂按外业出并标注，重判后自动放行。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        <el-button @click="copySummary">复制结论</el-button>
        <el-button type="primary" :icon="Download" :loading="busy" @click="handleExport">导出 JSON</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <el-alert
      v-if="totals.heldBelts > 0 || totals.pendingBelts > 0"
      :type="totals.heldBelts > 0 ? 'warning' : 'info'"
      :closable="false"
      show-icon
      class="gb-panel"
    >
      <template #title>
        定稿口径：挂起等复核 {{ totals.heldBelts }} 条不计入下方礁区结论；判读室尚未判读 {{ totals.pendingBelts }}
        条先按外业那份出并标注；重判后的样带自动放行。
      </template>
    </el-alert>

    <div class="gb-stats-row">
      <StatBadge label="样带数" :value="totals.belts" suffix="条" icon="Files" />
      <StatBadge label="计入定稿" :value="totals.conclusiveBelts" suffix="条" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="挂起复核" :value="totals.heldBelts" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="待判读" :value="totals.pendingBelts" suffix="条" tone="warning" icon="Clock" />
      <StatBadge label="平均覆盖率" :value="totals.avgCoveragePct" suffix="%" :percent="Math.min(100, totals.avgCoveragePct)" icon="PieChart" />
      <StatBadge
        label="平均白化指数"
        :value="totals.avgBleachIndex"
        suffix="/ 4"
        :tone="totals.avgBleachIndex > 1 ? 'warning' : 'success'"
        :icon="totals.avgBleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'reefIds',
          label: '礁区',
          options: reefStore.reefs.map((reef) => ({ label: reef.name, value: reef.id }))
        },
        {
          key: 'bleachLevels',
          label: '白化等级',
          options: BLEACH_LEVELS.map((level) => ({ label: level, value: level }))
        }
      ]"
      :has-switch="true"
      switch-label="仅看存在白化的样带"
      :switch-value="surveyStore.filter.onlyBleached"
      keyword-placeholder="搜索礁区 / 站位 / 样带 / 调查人"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>白化等级分布（覆盖长度 cm）</h3>
        <span class="gb-hint">
          总体白化指数 {{ surveyStore.globalStats.bleachIndex }}（{{ surveyStore.globalStats.grade }}）· 白化占比
          {{ surveyStore.globalStats.bleachedSharePct }}% · 存在白化样带 {{ totals.bleachedBelts }} 条
        </span>
      </div>
      <div class="gb-bars">
        <div v-for="level in BLEACH_LEVELS" :key="`dist-${level}`" class="gb-bar">
          <span>{{ level }}</span>
          <span class="gb-bar__track">
            <span
              class="gb-bar__fill"
              :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], distributionTotal) }"
            ></span>
          </span>
          <span class="gb-mono">{{ distribution[level] }} cm</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按样带的覆盖度成果（{{ rows.length }} 条）</h3>
        <span class="gb-hint">按白化指数降序排列</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="没有符合条件的样带"
        description="请先到礁区台账布设站位与样带，并录入珊瑚分类覆盖与鱼类计数；也可调整当前筛选条件。"
        compact
      />

      <el-table
        v-else
        :data="rows"
        border
        stripe
        class="gb-table-compact"
        :row-class-name="rowClassName"
      >
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}（{{ row.orientation }}向）</div>
          </template>
        </el-table-column>
        <el-table-column label="样带长度" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.lengthM }} m</span>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚记录" width="90" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coralCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业覆盖率" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fieldCoveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.fieldCoverCmTotal }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="判读覆盖率" width="130" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'pending'" size="small" type="warning" effect="plain">
              {{ row.isInitial ? '初始值·暂用外业' : '未判读·暂用外业' }}
            </el-tag>
            <span v-else class="gb-mono">{{ row.interpretedCoveragePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="差值 / 对账" width="150" align="center">
          <template #default="{ row }">
            <div v-if="row.status !== 'pending' && row.coverageDiffPct !== null" class="gb-mono" :class="{ 'coverage-view__danger': row.coverageDiffPct > COVERAGE_DIFF_THRESHOLD_PCT }">
              差 {{ row.coverageDiffPct }} 点
            </div>
            <div v-else class="gb-hint">—</div>
            <ReconcileTag :status="row.status" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="外业白化" width="160">
          <template #default="{ row }">
            <BleachTag :level="row.fieldGrade" size="small" />
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndex }} · 占比 {{ row.bleachedSharePct }}%</div>
          </template>
        </el-table-column>
        <el-table-column label="判读等级" width="90" align="center">
          <template #default="{ row }">
            <BleachTag v-if="row.status !== 'pending' && row.interpretedGrade" :level="row.interpretedGrade" size="small" :icon="false" />
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="白化等级分布 (cm)" min-width="200">
          <template #default="{ row }">
            <div class="page__mini-bars">
              <span
                v-for="level in BLEACH_LEVELS"
                :key="`${row.beltId}-${level}`"
                class="page__mini-bar"
                :style="{
                  background: BLEACH_COLOR[level],
                  width: barPercent(row.distribution[level], row.fieldCoverCmTotal),
                  opacity: row.distribution[level] > 0 ? 1 : 0.15
                }"
                :title="`${level}：${row.distribution[level]} cm`"
              ></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="鱼类" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }} 尾</span>
            <div class="gb-hint gb-mono">{{ row.fishDensityValue }} 尾/100m²</div>
          </template>
        </el-table-column>
        <el-table-column label="判读人 / 调查" min-width="150">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.surveyDate }}</div>
            <div class="gb-hint">判读：{{ row.reviewer || '未判读' }} ｜ 外业：{{ row.observer || '未填' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按礁区的白化评定（定稿口径）</h3>
        <span class="gb-hint">
          定稿报告照旧：平均白化指数只平均未挂起样带；括号标注挂起 / 待判读 / 放行条数
        </span>
      </div>
      <el-table :data="interpretStore.reefSummaries" border stripe class="gb-table-compact">
        <el-table-column prop="reefName" label="礁区" min-width="160" />
        <el-table-column prop="protectStatus" label="保护区状态" width="120" />
        <el-table-column label="站位 / 样带" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.siteCount }} / {{ row.conclusiveBeltCount }}<span class="gb-hint">（共 {{ row.beltCount }}）</span></span>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚记录" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coralCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均白化指数" width="150">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <span class="gb-hint gb-mono"> {{ row.avgBleachIndex }}</span>
          </template>
        </el-table-column>
        <el-table-column label="判读对账" min-width="210">
          <template #default="{ row }">
            <el-tag size="small" type="danger" effect="plain" class="coverage-view__status-tag">挂起 {{ row.heldCount }}</el-tag>
            <el-tag size="small" type="warning" effect="plain" class="coverage-view__status-tag">待判 {{ row.pendingCount }}</el-tag>
            <el-tag size="small" type="primary" effect="plain" class="coverage-view__status-tag">放行 {{ row.releasedCount }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="鱼类计数" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>结构版本与全量 JSON 导入导出</h3>
        <span class="gb-hint">
          导出内容包含 reefs / sites / belts / corals / fishes / interpretations 六张表 · 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>

      <el-form label-width="120px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（先清空本地数据）</el-radio>
            <el-radio :value="false">追加（重新分配 id）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="选择备份文件">
          <el-upload
            v-model:file-list="fileList"
            :auto-upload="false"
            :limit="1"
            accept="application/json"
            :on-exceed="() => ElMessage.warning('一次只能选择一个文件')"
          >
            <el-button :icon="Upload">选择 JSON 文件</el-button>
            <template #tip>
              <div class="gb-hint">仅支持本应用导出的备份文件（app 字段为 gbcoralbelt）</div>
            </template>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="busy" @click="handleImport">开始导入</el-button>
          <el-button :icon="Download" @click="handleExport">导出当前数据</el-button>
          <el-button type="danger" plain @click="handleDatabaseReset">清空并重建演示数据</el-button>
        </el-form-item>
      </el-form>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="本地库名">{{ DB_NAME }}</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（浏览器记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="礁区 / 站位">{{ counts.reefs }} / {{ counts.sites }}</el-descriptions-item>
        <el-descriptions-item label="样带 / 珊瑚记录">{{ counts.belts }} / {{ counts.corals }}</el-descriptions-item>
        <el-descriptions-item label="鱼类 / 判读记录">{{ counts.fishes }} / {{ counts.interpretations }}</el-descriptions-item>
        <el-descriptions-item label="最近备份时间">
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </el-descriptions-item>
      </el-descriptions>
      <p class="gb-hint">
        数据仅保存在当前浏览器 IndexedDB 中，换浏览器或清空站点数据后不会自动跟随，请通过 JSON 备份迁移。
      </p>
    </el-card>
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

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__mini-bars {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: #eef7f6;
}

.page__mini-bar {
  display: block;
  height: 100%;
}

.coverage-view__danger {
  color: #b03a2e;
  font-weight: 700;
}

.coverage-view__status-tag {
  margin: 2px 4px 2px 0;
}

:deep(.el-table .is-held) {
  background-color: #fdecea !important;
}

:deep(.el-table .is-pending) {
  background-color: #fdf8ec !important;
}
</style>
