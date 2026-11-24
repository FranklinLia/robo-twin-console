<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { sharedTelemetryBuffer } from '../services/telemetryBuffer';
import { useRobotStore } from '../stores/robot';

const JOINT_COLORS = [
  '#38bdf8', // J1 cyan
  '#f59e0b', // J2 amber
  '#34d399', // J3 emerald
  '#a78bfa', // J4 violet
  '#fb7185', // J5 rose
  '#e2e8f0', // J6 slate
];

const robotStore = useRobotStore();
const {
  joints,
  alarmLogs,
  telemetryDockOpen,
  maxTemperature,
  selectedJointName,
  connectionStatus,
  theme,
} = storeToRefs(robotStore);

const canvasWrapRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const selectedChannelFilter = ref<number | 'ALL'>('ALL');

let resizeObserver: ResizeObserver | null = null;
let rafId = 0;
let lastDrawnRevision = -1;
const scratchSeries = new Array<number>(sharedTelemetryBuffer.getCapacity()).fill(0);

const peakTorque = computed(() =>
  joints.value.reduce((max, j) => Math.max(max, Math.abs(j.effort)), 0)
);

const tempArcRatio = computed(() => Math.min(Math.max((maxTemperature.value - 20) / 80, 0), 1));
const torqueArcRatio = computed(() => Math.min(Math.max(peakTorque.value / 35, 0), 1));

const ARC_CIRCUMFERENCE = 2 * Math.PI * 22;

const tempStrokeColor = computed(() => {
  if (maxTemperature.value >= 80) return '#f87171';
  if (maxTemperature.value >= 65) return '#fbbf24';
  return '#34d399';
});

const formatTime = (ts: number) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const drawWaveform = (force = false) => {
  const canvas = canvasRef.value;
  if (!canvas || !telemetryDockOpen.value) return;

  const rev = sharedTelemetryBuffer.getRevision();
  if (!force && rev === lastDrawnRevision) return;
  lastDrawnRevision = rev;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  if (width <= 0 || height <= 0) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // 背景与网格线 (-pi ~ +pi)
  const padLeft = 34;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 10;
  const plotW = Math.max(1, width - padLeft - padRight);
  const plotH = Math.max(1, height - padTop - padBottom);

  const isLight = theme.value === 'light';
  ctx.strokeStyle = isLight ? 'rgba(148, 163, 184, 0.5)' : 'rgba(51, 65, 85, 0.55)';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = isLight ? '#475569' : '#64748b';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = [
    { label: '+180°', val: Math.PI },
    { label: '0°', val: 0 },
    { label: '-180°', val: -Math.PI },
  ];

  for (const tick of yTicks) {
    const norm = (Math.PI - tick.val) / (2 * Math.PI);
    const y = padTop + norm * plotH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.fillText(tick.label, padLeft - 4, y);
  }

  const len = sharedTelemetryBuffer.getLength();
  const cap = sharedTelemetryBuffer.getCapacity();

  if (len > 1) {
    for (let ch = 0; ch < 6; ch++) {
      if (selectedChannelFilter.value !== 'ALL' && selectedChannelFilter.value !== ch) {
        continue;
      }
      const count = sharedTelemetryBuffer.readChannelInto(ch, scratchSeries);
      if (count < 2) continue;

      ctx.strokeStyle = JOINT_COLORS[ch];
      ctx.lineWidth = selectedChannelFilter.value === ch ? 2.0 : 1.4;
      ctx.beginPath();

      for (let i = 0; i < count; i++) {
        const x = padLeft + ((i + (cap - count)) / (cap - 1)) * plotW;
        const clamped = Math.max(-Math.PI, Math.min(Math.PI, scratchSeries[i]));
        const y = padTop + ((Math.PI - clamped) / (2 * Math.PI)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText('等待关节遥测数据...', padLeft + plotW / 2, padTop + plotH / 2);
  }

  ctx.restore();
};

const syncCanvasSize = () => {
  const wrap = canvasWrapRef.value;
  const canvas = canvasRef.value;
  if (!wrap || !canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(wrap.clientWidth));
  const h = Math.max(1, Math.floor(wrap.clientHeight));
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    drawWaveform(true);
  }
};

const renderLoop = () => {
  if (!telemetryDockOpen.value) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(renderLoop);
  drawWaveform(false);
};

const injectTempTarget = () => {
  const target = selectedJointName.value ?? 'joint_2';
  robotStore.injectOverTemp(target, 86.5);
};

watch(selectedChannelFilter, () => drawWaveform(true));
watch(theme, () => drawWaveform(true));
watch(telemetryDockOpen, (open) => {
  if (open) {
    requestAnimationFrame(() => {
      syncCanvasSize();
      drawWaveform(true);
      if (rafId === 0) {
        rafId = requestAnimationFrame(renderLoop);
      }
    });
  } else if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
});

onMounted(() => {
  syncCanvasSize();
  if (canvasWrapRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(canvasWrapRef.value);
  }
  rafId = requestAnimationFrame(renderLoop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
});
</script>

<template>
  <section class="telemetry-dock" :class="{ collapsed: !telemetryDockOpen }">
    <div class="dock-header">
      <div class="dock-title-group">
        <button class="collapse-btn" @click="robotStore.toggleTelemetryDock()">
          {{ telemetryDockOpen ? '▾' : '▸' }} 遥测 HUD & 告警流
        </button>
        <span class="dock-pill" :data-status="connectionStatus">
          {{ connectionStatus }}
        </span>
      </div>

      <div class="dock-actions">
        <button class="hud-btn warn" @click="injectTempTarget">
          注入超温 (86.5°C)
        </button>
        <button class="hud-btn" @click="robotStore.clearFaults()">
          恢复温度
        </button>
      </div>
    </div>

    <div v-show="telemetryDockOpen" class="dock-body">
      <!-- 1. 自绘 Canvas 关节角度实时波形 -->
      <div class="dock-pane chart-pane">
        <div class="pane-head">
          <span>关节角度波形 (Canvas)</span>
          <div class="channel-pills">
            <button
              class="ch-pill"
              :class="{ active: selectedChannelFilter === 'ALL' }"
              @click="selectedChannelFilter = 'ALL'"
            >
              ALL
            </button>
            <button
              v-for="(j, idx) in joints"
              :key="j.name"
              class="ch-pill"
              :class="{ active: selectedChannelFilter === idx }"
              :style="{ '--ch-color': JOINT_COLORS[idx] }"
              @click="selectedChannelFilter = idx"
            >
              J{{ idx + 1 }}
            </button>
          </div>
        </div>
        <div ref="canvasWrapRef" class="canvas-wrap">
          <canvas ref="canvasRef" class="wave-canvas"></canvas>
        </div>
      </div>

      <!-- 2. 自绘 SVG 仪表盘 + 各关节温度/力矩条 -->
      <div class="dock-pane gauge-pane">
        <div class="pane-head">
          <span>力矩 / 温度仪表</span>
          <span class="pane-meta">阈值 65°C / 80°C</span>
        </div>
        <div class="gauge-layout">
          <div class="svg-gauges">
            <div class="radial-card">
              <svg viewBox="0 0 56 56" class="radial-svg">
                <circle cx="28" cy="28" r="22" class="radial-track" />
                <circle
                  cx="28"
                  cy="28"
                  r="22"
                  class="radial-fill"
                  :stroke="tempStrokeColor"
                  :stroke-dasharray="ARC_CIRCUMFERENCE"
                  :stroke-dashoffset="ARC_CIRCUMFERENCE * (1 - tempArcRatio)"
                />
              </svg>
              <div class="radial-val" :style="{ color: tempStrokeColor }">
                {{ maxTemperature.toFixed(1) }}°C
              </div>
              <div class="radial-label">MAX TEMP</div>
            </div>

            <div class="radial-card">
              <svg viewBox="0 0 56 56" class="radial-svg">
                <circle cx="28" cy="28" r="22" class="radial-track" />
                <circle
                  cx="28"
                  cy="28"
                  r="22"
                  class="radial-fill"
                  stroke="#38bdf8"
                  :stroke-dasharray="ARC_CIRCUMFERENCE"
                  :stroke-dashoffset="ARC_CIRCUMFERENCE * (1 - torqueArcRatio)"
                />
              </svg>
              <div class="radial-val">{{ peakTorque.toFixed(1) }}</div>
              <div class="radial-label">PEAK N·m</div>
            </div>
          </div>

          <div class="joint-bars">
            <div v-for="(j, idx) in joints" :key="j.name" class="bar-row">
              <span class="bar-name" :style="{ color: JOINT_COLORS[idx] }">J{{ idx + 1 }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :class="{
                    warn: j.temperature >= 65 && j.temperature < 80,
                    crit: j.temperature >= 80,
                  }"
                  :style="{ width: `${Math.min(100, (j.temperature / 100) * 100)}%` }"
                ></div>
              </div>
              <span class="bar-num">{{ j.temperature.toFixed(0) }}°C</span>
              <span class="bar-num eff">{{ j.effort.toFixed(1) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 告警事件流 -->
      <div class="dock-pane alarm-pane">
        <div class="pane-head">
          <span>告警与通信日志 ({{ alarmLogs.length }})</span>
          <button class="mini-clear" @click="robotStore.clearAlarmLogs()">清空</button>
        </div>
        <div class="alarm-list">
          <div v-if="alarmLogs.length === 0" class="alarm-empty">
            系统运行平稳，暂无告警事件
          </div>
          <div
            v-for="entry in alarmLogs"
            :key="entry.id"
            class="alarm-row"
            :data-level="entry.level"
          >
            <span class="alarm-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="alarm-badge">{{ entry.code }}</span>
            <span class="alarm-msg">{{ entry.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.telemetry-dock {
  height: 212px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
}

.telemetry-dock.collapsed {
  height: 30px;
}

.dock-header {
  height: 30px;
  flex-shrink: 0;
  padding: 0 12px;
  background: var(--bg-panel-elevated);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dock-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.collapse-btn {
  background: none;
  border: none;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.dock-pill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--status-ok-bg);
  color: var(--status-ok-fg);
}

.dock-pill[data-status='OFFLINE'] {
  background: var(--status-err-bg);
  color: var(--status-err-fg);
}

.dock-pill[data-status='CONNECTING'] {
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.dock-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hud-btn {
  padding: 2px 8px;
  font-family: inherit;
  font-size: 10px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
  background: rgba(15, 23, 42, 0.85);
  color: var(--text-muted);
  cursor: pointer;
}

.hud-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

.hud-btn.warn {
  color: var(--status-warn-fg);
  border-color: rgba(251, 191, 36, 0.45);
}

.dock-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1.45fr 1fr 1.15fr;
}

.dock-pane {
  min-width: 0;
  min-height: 0;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-right: 1px solid var(--border-subtle);
}

.dock-pane:last-child {
  border-right: none;
}

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.pane-meta {
  font-size: 10px;
  color: var(--text-muted);
}

.channel-pills {
  display: flex;
  gap: 3px;
}

.ch-pill {
  padding: 1px 5px;
  font-family: inherit;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.ch-pill.active {
  color: var(--ch-color, var(--accent));
  border-color: var(--ch-color, var(--accent));
  background: rgba(56, 189, 248, 0.12);
}

.canvas-wrap {
  flex: 1;
  min-height: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.wave-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.gauge-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
  align-items: center;
}

.svg-gauges {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.radial-card {
  position: relative;
  width: 66px;
  height: 68px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.radial-svg {
  width: 44px;
  height: 44px;
  transform: rotate(-90deg);
}

.radial-track {
  fill: none;
  stroke: var(--border-subtle);
  stroke-width: 5;
}

.radial-fill {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.15s ease;
}

.radial-val {
  position: absolute;
  top: 20px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-primary);
}

.radial-label {
  font-size: 8px;
  color: var(--text-muted);
  margin-top: 2px;
}

.joint-bars {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bar-row {
  display: grid;
  grid-template-columns: 22px 1fr 32px 32px;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.bar-name {
  font-weight: 700;
}

.bar-track {
  height: 6px;
  background: var(--border-subtle);
  border-radius: 3px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: #34d399;
  transition: width 0.12s linear;
}

.bar-fill.warn {
  background: #fbbf24;
}

.bar-fill.crit {
  background: #f87171;
}

.bar-num {
  text-align: right;
  color: var(--text-primary);
}

.bar-num.eff {
  color: var(--text-muted);
}

.mini-clear {
  background: none;
  border: none;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10px;
  cursor: pointer;
}

.mini-clear:hover {
  color: var(--accent);
}

.alarm-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.alarm-empty {
  margin: auto;
  font-size: 11px;
  color: #64748b;
}

.alarm-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 10px;
  background: var(--bg-card);
  border-left: 2px solid var(--accent);
}

@media (max-width: 1024px) {
  .telemetry-dock {
    height: auto;
  }
  .dock-body {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .dock-pane {
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
    min-height: 150px;
  }
}

.alarm-row[data-level='warning'] {
  border-left-color: var(--status-warn-fg);
  background: var(--status-warn-bg);
}

.alarm-row[data-level='critical'] {
  border-left-color: var(--status-err-fg);
  background: var(--status-err-bg);
}

.alarm-time {
  color: #64748b;
  flex-shrink: 0;
}

.alarm-badge {
  font-weight: 700;
  color: var(--text-primary);
  flex-shrink: 0;
}

.alarm-msg {
  color: var(--text-muted);
  word-break: break-word;
}
</style>
