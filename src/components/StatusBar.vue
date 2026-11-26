<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useRobotStore } from '../stores/robot';

const robotStore = useRobotStore();
const {
  connectionStatus,
  dataSourceMode,
  stress100HzEnabled,
  modelName,
  modelMode,
  joints,
  maxTemperature,
  activeAlarms,
  highestAlarmLevel,
  telemetryHz,
  latencyMs,
  selectedJointName,
  actionExecutionStatus,
  actionProgressPct,
  currentActionLabel,
} = storeToRefs(robotStore);
</script>

<template>
  <footer class="status-bar">
    <div class="status-group">
      <span class="conn-pill" :data-status="connectionStatus">
        <span class="conn-dot"></span>
        {{
          connectionStatus === 'LOCAL_SIM'
            ? stress100HzEnabled
              ? 'LOCAL 100Hz'
              : 'LOCAL SIM'
            : connectionStatus
        }}
      </span>
      <span class="divider">|</span>
      <span class="model-pill" :data-mode="modelMode">
        {{ modelMode === 'URDF' ? 'URDF' : 'MOCK' }}
      </span>
      <span class="meta-item"><strong>{{ modelName }}</strong></span>
      <span class="divider">|</span>
      <span class="meta-item">JOINTS: <strong>{{ joints.length }}</strong></span>
      <template v-if="actionExecutionStatus === 'EXECUTING'">
        <span class="divider">|</span>
        <span class="exec-status">{{ currentActionLabel }} · {{ actionProgressPct }}%</span>
      </template>
      <template v-else-if="actionExecutionStatus === 'PREVIEW'">
        <span class="divider">|</span>
        <span class="preview-status">动作预览待确认</span>
      </template>
      <template v-else-if="selectedJointName">
        <span class="divider">|</span>
        <span class="meta-item">PICKED: <strong class="picked-text">{{ selectedJointName }}</strong></span>
      </template>
    </div>

    <div class="status-group">
      <span class="meta-item">
        MAX TEMP: <strong>{{ maxTemperature.toFixed(1) }}°C</strong>
      </span>
      <span class="divider">|</span>
      <span class="meta-item" :class="`alarm-${highestAlarmLevel}`">
        ALARMS: <strong>{{ activeAlarms.length }}</strong>
      </span>
      <span class="divider">|</span>
      <span class="meta-item">
        RATE:
        <strong>
          {{
            dataSourceMode === 'LOCAL_SIM'
              ? stress100HzEnabled
                ? `${telemetryHz} Hz`
                : 'MANUAL'
              : connectionStatus === 'ONLINE'
                ? `${telemetryHz} Hz`
                : '0 Hz'
          }}
        </strong>
      </span>
      <span class="divider">|</span>
      <span class="meta-item">
        RTT:
        <strong>
          {{ connectionStatus === 'ONLINE' && latencyMs > 0 ? `${latencyMs} ms` : '--' }}
        </strong>
      </span>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  height: 36px;
  flex-shrink: 0;
  width: 100%;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-subtle);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
}

.status-group {
  display: flex;
  align-items: center;
  gap: 9px;
}

.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--status-ok-bg);
  color: var(--status-ok-fg);
  font-weight: 700;
}

.conn-pill[data-status='OFFLINE'] {
  background: var(--status-err-bg);
  color: var(--status-err-fg);
}

.conn-pill[data-status='CONNECTING'] {
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.model-pill {
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 700;
  background: rgba(14, 165, 233, 0.16);
  color: var(--accent);
}

.model-pill[data-mode='MOCK_FALLBACK'] {
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.divider {
  color: var(--border-subtle);
}

.meta-item strong {
  color: var(--text-primary);
  font-weight: 600;
}

.picked-text {
  color: var(--accent) !important;
}

.exec-status {
  color: var(--status-ok-fg);
  font-weight: 700;
}

.preview-status {
  color: var(--status-warn-fg);
  font-weight: 700;
}

.alarm-warning strong {
  color: var(--status-warn-fg);
}

.alarm-critical strong {
  color: var(--status-err-fg);
}
</style>
