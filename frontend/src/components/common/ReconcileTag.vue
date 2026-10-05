<script setup lang="ts">
/**
 * <ReconcileTag> 按样带两侧对账状态渲染徽标：
 * pending 待判读（暂用外业并标出）/ matched 对账一致 / held 挂起复核 / released 重判放行。
 * 被影像判读室（/interpretations）、覆盖度汇总页（/coverage）与样带布设页消费。
 */
import { computed } from 'vue'
import { CircleCheckFilled, Clock, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import type { ReconcileStatus } from '@/types/interpretation'
import { RECONCILE_STATUS_LABEL } from '@/types/interpretation'

const props = withDefaults(
  defineProps<{
    status: ReconcileStatus
    size?: 'default' | 'small'
  }>(),
  { size: 'default' }
)

const STATUS_META: Record<ReconcileStatus, { color: string; bg: string; icon: unknown; tip: string }> = {
  pending: {
    color: '#8a6d1d',
    bg: '#fdf6e0',
    icon: Clock,
    tip: '判读室尚未判读，汇总结论先按外业数据出并标注，待补判'
  },
  matched: {
    color: '#1e8449',
    bg: '#eaf6ee',
    icon: CircleCheckFilled,
    tip: '两侧覆盖率差值不超过 10 个百分点，对账一致'
  },
  held: {
    color: '#b03a2e',
    bg: '#fdecea',
    icon: WarningFilled,
    tip: '两侧覆盖率差过 10 个百分点，挂起等复核，暂不计入定稿礁区结论'
  },
  released: {
    color: '#1f618d',
    bg: '#eaf2fb',
    icon: RefreshRight,
    tip: '挂起后经判读室重判，已自动放行'
  }
}

const meta = computed(() => STATUS_META[props.status])
const style = computed(() => ({ color: meta.value.color, backgroundColor: meta.value.bg, borderColor: meta.value.color }))
</script>

<template>
  <el-tooltip :content="meta.tip" placement="top">
    <span class="reconcile-tag" :class="[`is-${size}`]" :style="style">
      <el-icon class="reconcile-tag__icon"><component :is="meta.icon" /></el-icon>
      <span>{{ RECONCILE_STATUS_LABEL[status] }}</span>
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
