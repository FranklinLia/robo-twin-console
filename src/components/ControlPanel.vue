<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { computeForwardKinematics } from '../services/kinematics';
import { useRobotStore } from '../stores/robot';
import type { EndEffectorPose, JointAlarm } from '../types/robot';

interface PanelJointView {
  name: string;
  urdfName: string;
  label: string;
  angle: number;
  min: number;
  max: number;
  velocity: number;
  effort: number;
  temperature: number;
  alarm: JointAlarm | null;
}

const PANEL_REFRESH_MS = 100; // 10Hz 刷新节流

const robotStore = useRobotStore();
const {
  joints,
  connectionStatus,
  dataSourceMode,
  motionMode,
  wsServerRunning,
  stress100HzEnabled,
  stressFrameCount,
  telemetryHz,
  modelMode,
  isHomePose,
  activeAlarms,
  selectedJointName,
  endEffectorPose,
  fkWorldErrorMm,
  viewportSettings,
  workspacePointCount,
  workspaceMaxReach,
  waypoints,
  trajectoryMode,
  plannedTrajectory,
  playbackState,
  playbackIndex,
  intentEngine,
  isParsingIntent,
  parseResult,
  safetyValidationError,
  actionExecutionStatus,
  compiledActionSteps,
  actionProgressPct,
  currentActionLabel,
  executionLogs,
} = storeToRefs(robotStore);

const activeTab = ref<'JOINTS' | 'KINEMATICS' | 'AGENT'>('JOINTS');
const promptInput = ref<string>('抓取红色工件放到 A 号料盘');
const draggingJointName = ref<string | null>(null);

const panelJoints = ref<PanelJointView[]>(
  joints.value.map((j) => ({
    name: j.name,
    urdfName: j.urdfName,
    label: j.label,
    angle: j.angle,
    min: j.min,
    max: j.max,
    velocity: j.velocity,
    effort: j.effort,
    temperature: j.temperature,
    alarm: j.alarm,
  }))
);
const panelPose = ref<EndEffectorPose>(endEffectorPose.value);
const panelFkErrorMm = ref<number | null>(fkWorldErrorMm.value);

const angleScratch = new Array<number>(joints.value.length).fill(0);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const refreshPanelNumbers = () => {
  const angles = robotStore.targetAngles;
  const velocities = robotStore.targetVelocities;
  const efforts = robotStore.targetEfforts;
  const temperatures = robotStore.targetTemperatures;
  const storeJoints = joints.value;

  for (let i = 0; i < panelJoints.value.length; i++) {
    const view = panelJoints.value[i];
    const storeItem = storeJoints[i];
    const nextAngle = angles[i] ?? storeItem.angle;
    angleScratch[i] = nextAngle;

    if (draggingJointName.value !== view.name) {
      view.angle = nextAngle;
    }
    view.velocity = velocities[i] ?? storeItem.velocity;
    view.effort = efforts[i] ?? storeItem.effort;
    view.temperature = temperatures[i] ?? storeItem.temperature;
    view.alarm = storeItem.alarm;
  }

  panelPose.value = computeForwardKinematics(angleScratch);
  panelFkErrorMm.value = fkWorldErrorMm.value;
};

onMounted(() => {
  refreshPanelNumbers();
  refreshTimer = setInterval(refreshPanelNumbers, PANEL_REFRESH_MS);
  window.addEventListener('pointerup', onSliderDragEnd);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', onSliderDragEnd);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

const QUICK_PROMPTS = [
  '移动到 home 位姿',
  '抓取红色工件放到 A 号料盘',
  '移动到蓝色料筒',
  '移动到 (0.2, -0.5, 0.3)',
  '执行 eval(bypass)',
  '今天天气怎么样',
];

const toDeg = (rad: number) => (rad * (180 / Math.PI)).toFixed(1);

const onSliderInput = (name: string, event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  robotStore.setJointAngle(name, value);
};

const onSliderDragEnd = () => {
  draggingJointName.value = null;
};

const onScrubInput = (event: Event) => {
  const idx = Number((event.target as HTMLInputElement).value);
  robotStore.seekTrajectory(idx);
};

const submitCommand = () => {
  void robotStore.parseNaturalCommand(promptInput.value);
};

const applyQuickPrompt = (text: string) => {
  promptInput.value = text;
  void robotStore.parseNaturalCommand(text);
};
</script>

<template>
  <aside class="control-sidebar">
    <div class="panel-header">
      <div>
        <h2>ROBO-TWIN 控制台</h2>
        <p class="panel-subtitle">
          {{ modelMode === 'URDF' ? 'URDF 数字孪生' : 'MOCK 降级模型' }} · {{ joints.length }} DOF
        </p>
      </div>
      <span class="status-badge" :data-status="connectionStatus">
        {{ connectionStatus === 'LOCAL_SIM' ? 'LOCAL SIM' : connectionStatus }}
      </span>
    </div>

    <!-- 三主选项卡 -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'JOINTS' }"
        @click="activeTab = 'JOINTS'"
      >
        关节示教
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'KINEMATICS' }"
        @click="activeTab = 'KINEMATICS'"
      >
        运动学
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'AGENT' }"
        @click="activeTab = 'AGENT'"
      >
        具身指令
      </button>
    </div>

    <!-- Tab 1: 关节示教与数据源控制 -->
    <template v-if="activeTab === 'JOINTS'">
      <div class="stream-controls">
        <div class="segmented-row">
          <button
            class="seg-btn"
            :class="{ active: dataSourceMode === 'WS_STREAM' }"
            @click="robotStore.switchDataSource('WS_STREAM')"
          >
            WS 遥测流
          </button>
          <button
            class="seg-btn"
            :class="{ active: dataSourceMode === 'LOCAL_SIM' }"
            @click="robotStore.switchDataSource('LOCAL_SIM')"
          >
            本地手动
          </button>
        </div>

        <div v-if="dataSourceMode === 'WS_STREAM'" class="stream-subcontrols">
          <button
            class="sub-btn"
            :class="{ active: motionMode === 'WAVE_DEMO' }"
            @click="robotStore.setServerMotionMode(motionMode === 'WAVE_DEMO' ? 'HOLD' : 'WAVE_DEMO')"
          >
            {{ motionMode === 'WAVE_DEMO' ? '暂停波形' : '自动波形' }}
          </button>
          <button
            class="sub-btn"
            :class="{ danger: wsServerRunning, recover: !wsServerRunning }"
            @click="robotStore.toggleMockWsServer()"
          >
            {{ wsServerRunning ? '停止 WS 服务' : '重启 WS 服务' }}
          </button>
        </div>

        <div class="stress-card" :class="{ active: stress100HzEnabled }">
          <div class="stress-header">
            <div class="stress-title-group">
              <span class="stress-title">本地 100Hz 高频数据推送</span>
              <span class="stress-sub">
                {{
                  stress100HzEnabled
                    ? `压测中 · ${telemetryHz} Hz · 累计 ${stressFrameCount} 帧 · UI 10Hz 节流`
                    : '用于压测 Float64Array + MotionBuffer 60FPS 插值'
                }}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="stress100HzEnabled"
              class="stress-switch"
              :class="{ on: stress100HzEnabled }"
              @click="robotStore.toggleStress100Hz()"
            >
              <span class="stress-thumb"></span>
              <span class="stress-state">{{ stress100HzEnabled ? 'ON' : 'OFF' }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="joint-list">
        <div
          v-for="joint in panelJoints"
          :key="joint.name"
          class="joint-item"
          :class="{
            'has-alarm': joint.alarm !== null,
            'is-selected': selectedJointName === joint.name,
          }"
          @click="robotStore.selectJoint(joint.name)"
        >
          <div class="joint-meta">
            <div class="joint-title-wrap">
              <span class="joint-label">{{ joint.label }}</span>
              <span class="joint-urdf-name">{{ joint.urdfName }}</span>
            </div>
            <code class="joint-angle">{{ toDeg(joint.angle) }}°</code>
          </div>

          <input
            type="range"
            :value="draggingJointName === joint.name ? undefined : joint.angle"
            :min="joint.min"
            :max="joint.max"
            step="0.01"
            @pointerdown.stop="draggingJointName = joint.name"
            @pointerup="onSliderDragEnd"
            @change="onSliderDragEnd"
            @input="onSliderInput(joint.name, $event)"
            @click.stop
          />

          <div class="joint-telemetry">
            <span>VEL {{ joint.velocity.toFixed(2) }}</span>
            <span>EFF {{ joint.effort.toFixed(1) }} N·m</span>
            <span
              :class="{
                'temp-warn': joint.temperature >= 65 && joint.temperature < 80,
                'temp-crit': joint.temperature >= 80,
              }"
            >
              {{ joint.temperature.toFixed(1) }}°C
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- Tab 2: 正运动学 FK、工作空间与示教轨迹回放 -->
    <template v-else-if="activeTab === 'KINEMATICS'">
      <div class="kin-card">
        <div class="card-title">
          <span>正运动学 FK 末端位姿</span>
          <span v-if="panelFkErrorMm !== null && modelMode === 'URDF'" class="ok-chip">
            Δ {{ panelFkErrorMm.toFixed(3) }}mm
          </span>
        </div>
        <div class="pose-table">
          <span>Three (Y-up)</span>
          <code>
            ({{ panelPose.threePosition[0].toFixed(3) }},
            {{ panelPose.threePosition[1].toFixed(3) }},
            {{ panelPose.threePosition[2].toFixed(3) }}) m
          </code>
          <span>ROS (Z-up)</span>
          <code>
            ({{ panelPose.rosPosition[0].toFixed(3) }},
            {{ panelPose.rosPosition[1].toFixed(3) }},
            {{ panelPose.rosPosition[2].toFixed(3) }}) m
          </code>
          <span>R / P / Y</span>
          <code>
            ({{ panelPose.rpyDeg[0].toFixed(1) }}°,
            {{ panelPose.rpyDeg[1].toFixed(1) }}°,
            {{ panelPose.rpyDeg[2].toFixed(1) }}°)
          </code>
        </div>
      </div>

      <div class="kin-card">
        <div class="card-title">
          <span>可达工作空间点云</span>
          <button
            class="mini-toggle"
            :class="{ active: viewportSettings.showWorkspace }"
            @click="robotStore.toggleViewportSetting('showWorkspace')"
          >
            {{ viewportSettings.showWorkspace ? '隐藏点云' : '生成并显示' }}
          </button>
        </div>
        <p class="card-note">
          <template v-if="workspacePointCount > 0">
            已采样 {{ workspacePointCount }} 个可达位姿，最大展臂半径 {{ workspaceMaxReach.toFixed(2) }} m
          </template>
          <template v-else>
            基于 Halton 准随机采样 2400 组关节配置，过滤地面以下区域
          </template>
        </p>
      </div>

      <div class="kin-card traj-card">
        <div class="card-title">
          <span>示教点与轨迹规划 ({{ waypoints.length }})</span>
        </div>

        <div class="wp-actions">
          <button class="sub-btn active" @click="robotStore.recordWaypoint()">
            + 记录当前点
          </button>
          <button class="sub-btn" @click="robotStore.loadSampleWaypoints()">
            加载 3 点示例
          </button>
          <button class="sub-btn" :disabled="waypoints.length === 0" @click="robotStore.clearWaypoints()">
            清空
          </button>
        </div>

        <div class="segmented-row">
          <button
            class="seg-btn"
            :class="{ active: trajectoryMode === 'JOINT' }"
            @click="robotStore.setTrajectoryMode('JOINT')"
          >
            关节空间插值
          </button>
          <button
            class="seg-btn"
            :class="{ active: trajectoryMode === 'CARTESIAN_LINEAR' }"
            @click="robotStore.setTrajectoryMode('CARTESIAN_LINEAR')"
          >
            末端直线 (IK)
          </button>
        </div>

        <div class="wp-list">
          <div v-if="waypoints.length === 0" class="wp-empty">
            暂无示教点，请点击「记录当前点」或「加载 3 点示例」
          </div>
          <div
            v-for="wp in waypoints"
            :key="wp.id"
            class="wp-row"
            @click="robotStore.jumpToWaypoint(wp.id)"
          >
            <div class="wp-info">
              <span class="wp-name">{{ wp.name }}</span>
              <code class="wp-pos">
                ({{ wp.threePosition[0].toFixed(2) }}, {{ wp.threePosition[1].toFixed(2) }}, {{ wp.threePosition[2].toFixed(2) }})
              </code>
            </div>
            <button class="wp-del" @click.stop="robotStore.removeWaypoint(wp.id)">×</button>
          </div>
        </div>

        <div class="playback-box">
          <div class="playback-btns">
            <button
              class="sub-btn active"
              :disabled="plannedTrajectory.length < 2"
              @click="playbackState === 'PLAYING' ? robotStore.pauseTrajectory() : robotStore.playTrajectory()"
            >
              {{ playbackState === 'PLAYING' ? '暂停' : '播放轨迹' }}
            </button>
            <button
              class="sub-btn"
              :disabled="plannedTrajectory.length < 2"
              @click="robotStore.stepTrajectory()"
            >
              单步
            </button>
            <button
              class="sub-btn"
              :disabled="plannedTrajectory.length < 2"
              @click="robotStore.stopTrajectory()"
            >
              停止
            </button>
          </div>

          <div v-if="plannedTrajectory.length >= 2" class="scrub-row">
            <input
              type="range"
              :value="playbackIndex"
              :min="0"
              :max="plannedTrajectory.length - 1"
              @input="onScrubInput($event)"
            />
            <span class="scrub-label">{{ playbackIndex + 1 }}/{{ plannedTrajectory.length }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- Tab 3: 具身智能层（自然语言解析 -> 结构化动作 -> 预览确认 -> 执行反馈） -->
    <template v-else>
      <div class="kin-card">
        <div class="card-title">
          <span>意图解析引擎</span>
          <button class="mini-toggle" @click="robotStore.resetSceneObjects()">
            复位场景物体
          </button>
        </div>
        <div class="segmented-row">
          <button
            class="seg-btn"
            :class="{ active: intentEngine === 'LOCAL_RULE' }"
            @click="intentEngine = 'LOCAL_RULE'"
          >
            本地语义解析
          </button>
          <button
            class="seg-btn"
            :class="{ active: intentEngine === 'GEMINI' }"
            @click="intentEngine = 'GEMINI'"
          >
            Gemini 4 (服务端)
          </button>
        </div>

        <div class="prompt-row">
          <input
            v-model="promptInput"
            type="text"
            class="prompt-input"
            placeholder="输入自然语言控制指令..."
            @keyup.enter="submitCommand"
          />
          <button
            class="parse-btn"
            :disabled="isParsingIntent || actionExecutionStatus === 'EXECUTING'"
            @click="submitCommand"
          >
            {{ isParsingIntent ? '解析中' : '解析预览' }}
          </button>
        </div>

        <div class="quick-chips">
          <button
            v-for="q in QUICK_PROMPTS"
            :key="q"
            class="chip-btn"
            @click="applyQuickPrompt(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>

      <!-- 解析结果与安全校验 -->
      <div v-if="safetyValidationError" class="safety-box rejected">
        <strong>安全拦截 / 无法解析</strong>
        <p>{{ safetyValidationError }}</p>
      </div>

      <div v-else-if="parseResult && compiledActionSteps.length > 0" class="kin-card">
        <div class="card-title">
          <span>结构化动作序列 ({{ compiledActionSteps.length }})</span>
          <span class="ok-chip">{{ actionExecutionStatus }}</span>
        </div>
        <p class="card-note">{{ parseResult.reason }}</p>

        <div class="action-steps">
          <div
            v-for="step in compiledActionSteps"
            :key="step.index"
            class="action-step-row"
          >
            <span class="step-type">{{ step.action.type }}</span>
            <span class="step-desc">{{ step.action.description }}</span>
          </div>
        </div>

        <div v-if="actionExecutionStatus === 'PREVIEW'" class="confirm-bar">
          <button class="confirm-btn" @click="robotStore.confirmAndExecuteActions()">
            确认执行 (已预览轨迹)
          </button>
          <button class="sub-btn" @click="robotStore.cancelActionPreview()">
            取消
          </button>
        </div>

        <div v-else-if="actionExecutionStatus === 'EXECUTING'" class="exec-progress-box">
          <div class="exec-label">{{ currentActionLabel }} ({{ actionProgressPct }}%)</div>
          <div class="exec-track">
            <div class="exec-fill" :style="{ width: `${actionProgressPct}%` }"></div>
          </div>
        </div>
      </div>

      <!-- 执行日志 -->
      <div class="kin-card traj-card">
        <div class="card-title">
          <span>任务执行日志 ({{ executionLogs.length }})</span>
        </div>
        <div class="exec-logs">
          <div v-if="executionLogs.length === 0" class="wp-empty">
            输入指令后将先生成 3D 轨迹预览，确认后执行
          </div>
          <div
            v-for="log in executionLogs"
            :key="log.id"
            class="exec-log-row"
            :data-level="log.level"
          >
            {{ log.message }}
          </div>
        </div>
      </div>
    </template>

    <div class="panel-footer">
      <div v-if="activeAlarms.length > 0" class="alarm-summary">
        当前 {{ activeAlarms.length }} 项活动告警
      </div>
      <button
        class="reset-btn"
        :disabled="isHomePose"
        @click="robotStore.resetPose()"
      >
        归零姿态 (Home Pose)
      </button>
    </div>
  </aside>
</template>

<style scoped>
.control-sidebar {
  width: 368px;
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-panel-elevated);
  border-left: 1px solid var(--border-subtle);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 8px;
}

.panel-header h2 {
  font-size: 15px;
  color: var(--accent);
  line-height: 1.3;
}

.panel-subtitle {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
}

.status-badge {
  font-size: 10px;
  font-weight: 700;
  background: var(--status-ok-bg);
  color: var(--status-ok-fg);
  padding: 3px 7px;
  border-radius: 4px;
  white-space: nowrap;
}

.status-badge[data-status='OFFLINE'] {
  background: var(--status-err-bg);
  color: var(--status-err-fg);
}

.status-badge[data-status='CONNECTING'] {
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.tab-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 3px;
  border-radius: 7px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
}

.tab-btn {
  padding: 5px 6px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.tab-btn.active {
  background: rgba(14, 165, 233, 0.2);
  color: var(--accent);
}

.stream-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.segmented-row,
.stream-subcontrols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.seg-btn,
.sub-btn,
.mini-toggle {
  padding: 5px 8px;
  font-family: inherit;
  font-size: 11px;
  border-radius: 5px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.seg-btn:disabled,
.sub-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.seg-btn.active,
.sub-btn.active,
.mini-toggle.active {
  color: var(--accent);
  border-color: rgba(56, 189, 248, 0.6);
  background: rgba(14, 165, 233, 0.14);
}

.sub-btn.danger {
  color: var(--status-err-fg);
  border-color: rgba(248, 113, 113, 0.4);
}

.sub-btn.recover {
  color: var(--status-ok-fg);
  border-color: rgba(52, 211, 153, 0.5);
}

.stress-card {
  padding: 7px 9px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.stress-card.active {
  border-color: rgba(245, 158, 11, 0.65);
  background: rgba(245, 158, 11, 0.08);
}

.stress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stress-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stress-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
}

.stress-card.active .stress-title {
  color: var(--status-warn-fg);
}

.stress-sub {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stress-switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px 3px 4px;
  border-radius: 5px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card-inner);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}

.stress-switch.on {
  border-color: var(--status-warn-fg);
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.stress-thumb {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: currentColor;
  opacity: 0.85;
}

.joint-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.joint-item {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.joint-item:hover {
  border-color: rgba(56, 189, 248, 0.5);
}

.joint-item.is-selected {
  border-color: var(--accent);
  background: rgba(14, 165, 233, 0.12);
}

.joint-item.has-alarm {
  border-color: var(--status-warn-fg);
}

.joint-meta {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
}

.joint-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.joint-label {
  color: var(--text-primary);
  font-size: 12px;
}

.joint-urdf-name {
  font-size: 10px;
  color: var(--text-muted);
}

.joint-angle {
  color: var(--accent);
  font-size: 12px;
  white-space: nowrap;
}

.joint-item input[type='range'],
.scrub-row input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
}

.joint-telemetry {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted);
}

.temp-warn {
  color: var(--status-warn-fg);
  font-weight: 700;
}

.temp-crit {
  color: var(--status-err-fg);
  font-weight: 700;
}

.kin-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.traj-card {
  flex: 1;
  min-height: 0;
}

.card-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
}

.ok-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--status-ok-bg);
  color: var(--status-ok-fg);
}

.pose-table {
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 4px 6px;
  font-size: 10px;
  color: var(--text-muted);
}

.pose-table code {
  color: var(--accent);
}

.card-note {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.45;
}

.wp-actions {
  display: grid;
  grid-template-columns: 1.2fr 1.2fr 0.7fr;
  gap: 5px;
}

.wp-list,
.exec-logs {
  flex: 1;
  min-height: 80px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wp-empty {
  margin: auto;
  text-align: center;
  font-size: 10px;
  color: #64748b;
  padding: 10px 6px;
}

.wp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 5px;
  background: var(--bg-card-inner);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
}

.wp-row:hover {
  border-color: var(--accent);
}

.wp-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.wp-name {
  font-size: 11px;
  color: var(--text-primary);
}

.wp-pos {
  font-size: 10px;
  color: var(--text-muted);
}

.wp-del {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
}

.wp-del:hover {
  color: var(--status-err-fg);
}

.playback-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
}

.playback-btns {
  display: grid;
  grid-template-columns: 1.3fr 0.8fr 0.8fr;
  gap: 5px;
}

.scrub-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scrub-label {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.prompt-row {
  display: flex;
  gap: 6px;
}

.prompt-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 5px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 11px;
}

.prompt-input:focus {
  outline: none;
  border-color: var(--accent);
}

.parse-btn {
  padding: 6px 10px;
  border-radius: 5px;
  border: none;
  background: var(--accent-strong);
  color: #fff;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.parse-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip-btn {
  padding: 2px 6px;
  font-family: inherit;
  font-size: 10px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card-inner);
  color: var(--text-muted);
  cursor: pointer;
}

.chip-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.safety-box.rejected {
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-fg);
  color: var(--status-err-fg);
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.action-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.action-step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--bg-card-inner);
  font-size: 10px;
}

.step-type {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(14, 165, 233, 0.2);
  color: var(--accent);
  font-weight: 700;
  text-transform: uppercase;
}

.step-desc {
  color: var(--text-primary);
}

.confirm-bar {
  display: grid;
  grid-template-columns: 1.5fr 0.7fr;
  gap: 6px;
}

.confirm-btn {
  padding: 6px 10px;
  border-radius: 5px;
  border: none;
  background: #059669;
  color: #fff;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.confirm-btn:hover {
  background: #047857;
}

.exec-progress-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.exec-label {
  font-size: 10px;
  color: var(--status-ok-fg);
}

.exec-track {
  height: 6px;
  background: var(--border-subtle);
  border-radius: 3px;
  overflow: hidden;
}

.exec-fill {
  height: 100%;
  background: #34d399;
  transition: width 0.08s linear;
}

.exec-log-row {
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 10px;
  background: var(--bg-card-inner);
  border-left: 2px solid var(--accent);
  color: var(--text-muted);
}

.exec-log-row[data-level='success'] {
  border-left-color: var(--status-ok-fg);
  color: var(--status-ok-fg);
}

.exec-log-row[data-level='warn'] {
  border-left-color: var(--status-warn-fg);
  color: var(--status-warn-fg);
}

.exec-log-row[data-level='error'] {
  border-left-color: var(--status-err-fg);
  color: var(--status-err-fg);
}

.panel-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 2px;
}

.alarm-summary {
  font-size: 11px;
  padding: 5px 9px;
  border-radius: 6px;
  background: var(--status-warn-bg);
  color: var(--status-warn-fg);
}

.reset-btn {
  width: 100%;
  padding: 8px 12px;
  background: var(--accent-strong);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}

.reset-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.reset-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 1024px) {
  .control-sidebar {
    width: 100%;
    height: auto;
    border-left: none;
    border-top: 1px solid var(--border-subtle);
  }
}
</style>
