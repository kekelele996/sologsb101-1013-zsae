<script setup lang="ts">
/**
 * <ReconcileTag> 对账状态徽标：挂起 / 未判读 / 放行。
 * 挂起（两侧覆盖率差过一成）用警示色，未判读（按外业先出）用提示色，放行用安全色。
 * 被珊瑚计数页（/belts/:id/corals）与覆盖度汇总页（/coverage）消费。
 */
import { computed } from 'vue'
import { CircleCheckFilled, Warning, InfoFilled } from '@element-plus/icons-vue'
import type { ReconcileStatus } from '@/utils/reconcile'
import { RECONCILE_STATUS_LABEL } from '@/utils/reconcile'

const props = withDefaults(
  defineProps<{
    status: ReconcileStatus
    /** 是否显示图标 */
    icon?: boolean
    size?: 'default' | 'small'
  }>(),
  {
    icon: true,
    size: 'default'
  }
)

const statusColor: Record<ReconcileStatus, string> = {
  pending: '#c0392b',
  uninterpreted: '#d68910',
  released: '#1e8449'
}

const statusBg: Record<ReconcileStatus, string> = {
  pending: '#f6e4e2',
  uninterpreted: '#fdf3e3',
  released: '#eaf6ee'
}

const iconComponent = computed(() => {
  if (props.status === 'pending') return Warning
  if (props.status === 'uninterpreted') return InfoFilled
  return CircleCheckFilled
})

const color = computed(() => statusColor[props.status])
const bg = computed(() => statusBg[props.status])
const label = computed(() => RECONCILE_STATUS_LABEL[props.status])
</script>

<template>
  <el-tooltip
    :content="
      status === 'pending'
        ? '外业与判读覆盖率差过一成，样带挂起等复核'
        : status === 'uninterpreted'
          ? '判读室尚未判读，按外业那份先出并标出'
          : '外业与判读覆盖率差异在一成以内，放行'
    "
    placement="top"
  >
    <span
      class="reconcile-tag"
      :class="[`is-${size}`]"
      :style="{ color: color, backgroundColor: bg, borderColor: color }"
    >
      <el-icon v-if="icon" class="reconcile-tag__icon"><component :is="iconComponent" /></el-icon>
      <span class="reconcile-tag__text">{{ label }}</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.reconcile-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.reconcile-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.reconcile-tag__icon {
  font-size: 13px;
}
</style>
