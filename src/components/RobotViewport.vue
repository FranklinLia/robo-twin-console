<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { sharedMotionBuffer } from '../core/MotionBuffer';
import { RobotEngine } from '../core/RobotEngine';
import type { SemanticLabelCoord } from '../core/types';
import { useRobotStore } from '../stores/robot';

const robotStore = useRobotStore();
const {
  joints,
  urdfUrl,
  modelMode,
  modelLoadError,
  forceFallbackTest,
  viewportSettings,
  cameraResetVersion,
  cameraPreset,
  theme,
  pickedJointInfo,
  selectedJointName,
  endEffectorPose,
  fkWorldErrorMm,
  waypoints,
  plannedTrajectory,
  trajectoryMode,
  playbackState,
  playbackIndex,
  sceneObjects,
  heldObjectId,
  previewTrajectory,
  actionExecutionStatus,
  actionFrameIndex,
} = storeToRefs(robotStore);

const containerRef = ref<HTMLDivElement | null>(null);
const isLoadingModel = ref<boolean>(true);
const showShortcutHelp = ref<boolean>(false);
const semanticLabels = ref<SemanticLabelCoord[]>([]);

let robotEngine: RobotEngine | null = null;

const toDeg = (rad: number) => (rad * (180 / Math.PI)).toFixed(1);
const pickedDisplay = computed(() => pickedJointInfo.value);

watch(
  [sceneObjects, heldObjectId],
  ([nextObjects, nextHeldId]) => {
    robotEngine?.syncSemanticObjects(nextObjects, nextHeldId);
  },
  { deep: true }
);

watch(urdfUrl, (newUrl) => {
  void robotEngine?.loadRobotModel(newUrl);
});

watch(
  viewportSettings,
  (nextSettings) => {
    robotEngine?.applyViewportSettings(nextSettings, joints.value);
  },
  { deep: true }
);

watch(theme, (nextTheme) => {
  robotEngine?.setTheme(nextTheme);
});

watch(cameraResetVersion, () => {
  robotEngine?.setCameraPreset(cameraPreset.value);
});

watch(selectedJointName, (nextJointName) => {
  robotEngine?.syncSelectedJoint(nextJointName);
});

watch(
  [plannedTrajectory, waypoints, trajectoryMode, playbackState, playbackIndex],
  ([nextTraj, nextWps, nextMode, nextPlaybackState, nextPlaybackIndex]) => {
    robotEngine?.updateTrajectoryOverlay(
      nextWps,
      nextTraj,
      nextMode,
      nextPlaybackState,
      nextPlaybackIndex
    );
  },
  { deep: true }
);

watch(
  [previewTrajectory, actionExecutionStatus, actionFrameIndex],
  ([nextPreviewTraj, nextExecStatus, nextFrameIndex]) => {
    robotEngine?.updateActionPreviewOverlay(
      nextPreviewTraj,
      nextExecStatus,
      nextFrameIndex
    );
  },
  { deep: true }
);

onMounted(() => {
  if (!containerRef.value) return;
  robotEngine = new RobotEngine({
    container: containerRef.value,
    motionBuffer: sharedMotionBuffer,
    theme: theme.value,
    viewportSettings: viewportSettings.value,
    joints: joints.value,
    initialAngles: robotStore.targetAngles,
    sceneObjects: sceneObjects.value,
    heldObjectId: heldObjectId.value,
    urdfUrl: urdfUrl.value,
    selectedJointName: selectedJointName.value,
    waypoints: waypoints.value,
    plannedTrajectory: plannedTrajectory.value,
    trajectoryMode: trajectoryMode.value,
    playbackState: playbackState.value,
    playbackIndex: playbackIndex.value,
    previewTrajectory: previewTrajectory.value,
    actionExecutionStatus: actionExecutionStatus.value,
    actionFrameIndex: actionFrameIndex.value,
    callbacks: {
      onModelLoadingChange: (loading) => {
        isLoadingModel.value = loading;
      },
      onModelStatusChange: (mode, name, error) => {
        robotStore.setModelStatus(mode, name, error);
      },
      onJointPicked: (storeJointName, linkName) => {
        robotStore.selectJoint(storeJointName, linkName);
      },
      onToolWorldPosition: (pos) => {
        robotStore.setThreeWorldToolPos(pos);
      },
      onWorkspaceStats: (count, maxReachMeters) => {
        robotStore.setWorkspaceStats(count, maxReachMeters);
      },
      onSemanticLabelsUpdate: (labels) => {
        semanticLabels.value = labels;
      },
    },
  });
});

onBeforeUnmount(() => {
  robotEngine?.dispose();
  robotEngine = null;
});
</script>

<template>
  <div class="viewport-wrapper">
    <div ref="containerRef" class="viewport-container"></div>

    <!-- 语义物体 3D 投影标签层 -->
    <div v-if="viewportSettings.showSemantics" class="semantic-labels-layer">
      <div
        v-for="tag in semanticLabels"
        v-show="tag.visible"
        :key="tag.id"
        class="semantic-tag"
        :class="{ held: tag.isHeld }"
        :style="{ transform: `translate(${tag.x}px, ${tag.y}px) translate(-50%, -100%)` }"
      >
        <span class="semantic-id">{{ tag.id }}</span>
        <span>{{ tag.label }}</span>
      </div>
    </div>

    <!-- 视口左上角场景增强工具条 -->
    <div class="viewport-toolbar">
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showGrid }"
        @click="robotStore.toggleViewportSetting('showGrid')"
      >
        网格 Grid
      </button>
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showAxes }"
        @click="robotStore.toggleViewportSetting('showAxes')"
      >
        世界轴
      </button>
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showToolAxes }"
        @click="robotStore.toggleViewportSetting('showToolAxes')"
      >
        末端 Tool0
      </button>
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showWorkspace }"
        @click="robotStore.toggleViewportSetting('showWorkspace')"
      >
        工作空间
      </button>
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showSemantics }"
        @click="robotStore.toggleViewportSetting('showSemantics')"
      >
        语义标注
      </button>
      <button
        class="tool-btn"
        :class="{ active: viewportSettings.showShadows }"
        @click="robotStore.toggleViewportSetting('showShadows')"
      >
        阴影
      </button>
      <button class="tool-btn" @click="robotStore.triggerCameraReset('ISO')">
        复位视角
      </button>
      <button class="tool-btn" @click="robotStore.toggleTheme()">
        {{ theme === 'dark' ? '浅色主题' : '深色主题' }}
      </button>
      <button
        class="tool-btn"
        :class="{ warn: forceFallbackTest }"
        @click="robotStore.setForceFallbackTest(!forceFallbackTest)"
      >
        {{ forceFallbackTest ? '恢复 URDF' : '模拟降级' }}
      </button>
      <button
        class="tool-btn"
        :class="{ active: showShortcutHelp }"
        @click="showShortcutHelp = !showShortcutHelp"
      >
        ? 快捷键
      </button>
    </div>

    <!-- 快捷键帮助浮窗 -->
    <div v-if="showShortcutHelp" class="shortcut-popover">
      <div class="shortcut-title">控制台快捷键</div>
      <div class="shortcut-grid">
        <kbd>1</kbd><span>等轴测视角 (ISO)</span>
        <kbd>2</kbd><span>正视图 (Front)</span>
        <kbd>3</kbd><span>侧视图 (Side)</span>
        <kbd>4</kbd><span>俯视图 (Top)</span>
        <kbd>R</kbd><span>归零姿态 (Home)</span>
        <kbd>Space</kbd><span>播放 / 暂停</span>
        <kbd>G</kbd><span>开关网格</span>
        <kbd>W</kbd><span>开关工作空间</span>
        <kbd>T</kbd><span>切换深浅主题</span>
      </div>
    </div>

    <!-- 视口右上角末端 FK 位姿实时 HUD -->
    <div class="tcp-hud">
      <div class="tcp-title">TCP 末端位姿 (FK)</div>
      <div class="tcp-grid">
        <span>X {{ endEffectorPose.threePosition[0].toFixed(3) }}m</span>
        <span>Y {{ endEffectorPose.threePosition[1].toFixed(3) }}m</span>
        <span>Z {{ endEffectorPose.threePosition[2].toFixed(3) }}m</span>
        <span>R {{ endEffectorPose.rpyDeg[0].toFixed(1) }}°</span>
        <span>P {{ endEffectorPose.rpyDeg[1].toFixed(1) }}°</span>
        <span>Y {{ endEffectorPose.rpyDeg[2].toFixed(1) }}°</span>
      </div>
      <div v-if="fkWorldErrorMm !== null && modelMode === 'URDF'" class="tcp-err">
        FK vs World 误差: {{ fkWorldErrorMm.toFixed(3) }} mm
      </div>
    </div>

    <!-- 加载中 / 降级提示 -->
    <div v-if="isLoadingModel" class="viewport-banner info">
      正在加载 URDF 模型...
    </div>
    <div v-else-if="modelMode === 'MOCK_FALLBACK' && modelLoadError" class="viewport-banner warn">
      <span>{{ modelLoadError }}</span>
      <button class="banner-retry" @click="robotStore.setForceFallbackTest(false)">
        重试 URDF
      </button>
    </div>

    <!-- Raycaster 拾取信息浮窗 -->
    <div v-if="pickedDisplay" class="picked-card">
      <div class="picked-header">
        <span class="picked-tag">PICKED JOINT</span>
        <button class="picked-close" @click="robotStore.selectJoint(null, null)">×</button>
      </div>
      <div class="picked-title">{{ pickedDisplay.label }}</div>
      <div class="picked-grid">
        <span>Store Key</span>
        <code>{{ pickedDisplay.storeJointName }}</code>
        <span>URDF Joint</span>
        <code>{{ pickedDisplay.urdfJointName }}</code>
        <span>Link</span>
        <code>{{ pickedDisplay.linkName }}</code>
        <span>Angle</span>
        <code>{{ toDeg(pickedDisplay.angle) }}° ({{ pickedDisplay.angle.toFixed(3) }} rad)</code>
        <span>Limits</span>
        <code>[{{ toDeg(pickedDisplay.min) }}°, {{ toDeg(pickedDisplay.max) }}°]</code>
      </div>
    </div>

    <div v-else class="viewport-hint">
      左键拖拽旋转 · 滚轮缩放 · 点击连杆拾取 · 按 ? 查看快捷键
    </div>
  </div>
</template>

<style scoped>
.viewport-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
}

.viewport-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
}

.viewport-container:active {
  cursor: grabbing;
}

.semantic-labels-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 5;
}

.semantic-tag {
  position: absolute;
  top: 0;
  left: 0;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--bg-overlay);
  border: 1px solid rgba(251, 191, 36, 0.65);
  color: var(--text-primary);
  font-size: 10px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
}

.semantic-tag.held {
  border-color: var(--status-ok-fg);
  background: var(--status-ok-bg);
}

.semantic-id {
  color: #f59e0b;
  font-weight: 700;
}

.viewport-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  max-width: calc(100% - 260px);
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  z-index: 10;
}

.tool-btn {
  padding: 5px 8px;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tool-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

.tool-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: rgba(14, 165, 233, 0.14);
}

.tool-btn.warn {
  color: var(--status-warn-fg);
  border-color: var(--status-warn-fg);
  background: var(--status-warn-bg);
}

.shortcut-popover {
  position: absolute;
  top: 48px;
  left: 12px;
  width: 240px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  z-index: 15;
}

.shortcut-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 6px;
}

.shortcut-grid {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 4px 8px;
  font-size: 10px;
  color: var(--text-muted);
  align-items: center;
}

.shortcut-grid kbd {
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card-inner);
  color: var(--text-primary);
  text-align: center;
  font-family: inherit;
}

.tcp-hud {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 228px;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  z-index: 10;
  pointer-events: none;
}

.tcp-title {
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 5px;
}

.tcp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px 6px;
  font-size: 10px;
  color: var(--text-primary);
}

.tcp-err {
  margin-top: 5px;
  padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
  font-size: 10px;
  color: var(--status-ok-fg);
}

.viewport-banner {
  position: absolute;
  top: 48px;
  left: 12px;
  max-width: 500px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 10;
}

.viewport-banner.info {
  background: var(--bg-overlay);
  border: 1px solid var(--accent);
  color: var(--accent);
}

.viewport-banner.warn {
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-fg);
  color: var(--status-warn-fg);
}

.banner-retry {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.picked-card {
  position: absolute;
  bottom: 14px;
  left: 14px;
  width: 310px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-overlay);
  border: 1px solid var(--accent);
  z-index: 10;
}

.picked-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.picked-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
}

.picked-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

.picked-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.picked-grid {
  display: grid;
  grid-template-columns: 82px 1fr;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.picked-grid code {
  color: var(--text-primary);
  word-break: break-all;
}

.viewport-hint {
  position: absolute;
  bottom: 12px;
  left: 14px;
  padding: 4px 10px;
  border-radius: 5px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-subtle);
  font-size: 11px;
  color: var(--text-muted);
  pointer-events: none;
}
</style>