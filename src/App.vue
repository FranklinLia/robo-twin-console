<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import RobotViewport from './components/RobotViewport.vue';
import TelemetryDock from './components/TelemetryDock.vue';
import ControlPanel from './components/ControlPanel.vue';
import StatusBar from './components/StatusBar.vue';
import { useRobotStore } from './stores/robot';

const robotStore = useRobotStore();

const handleGlobalKeydown = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  ) {
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key.toLowerCase();
  if (key === '1') {
    robotStore.triggerCameraReset('ISO');
  } else if (key === '2') {
    robotStore.triggerCameraReset('FRONT');
  } else if (key === '3') {
    robotStore.triggerCameraReset('SIDE');
  } else if (key === '4') {
    robotStore.triggerCameraReset('TOP');
  } else if (key === 'r') {
    robotStore.resetPose();
  } else if (key === 'g') {
    robotStore.toggleViewportSetting('showGrid');
  } else if (key === 'w') {
    robotStore.toggleViewportSetting('showWorkspace');
  } else if (key === 't') {
    robotStore.toggleTheme();
  } else if (event.code === 'Space') {
    event.preventDefault();
    if (robotStore.plannedTrajectory.length >= 2) {
      if (robotStore.playbackState === 'PLAYING') {
        robotStore.pauseTrajectory();
      } else {
        robotStore.playTrajectory();
      }
    } else if (robotStore.dataSourceMode === 'WS_STREAM') {
      robotStore.setServerMotionMode(
        robotStore.motionMode === 'WAVE_DEMO' ? 'HOLD' : 'WAVE_DEMO'
      );
    }
  }
};

onMounted(() => {
  robotStore.initTheme();
  void robotStore.syncServerStatus();
  void robotStore.setStress100Hz(true);
  window.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  robotStore.disposeStoreTimers();
});
</script>

<template>
  <div class="console-shell">
    <div class="workspace-row">
      <div class="main-column">
        <main class="viewport-area">
          <RobotViewport />
        </main>
        <TelemetryDock />
      </div>
      <ControlPanel />
    </div>
    <StatusBar />
  </div>
</template>

<style scoped>
.console-shell {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}

.workspace-row {
  flex: 1;
  min-height: 0;
  display: flex;
}

.main-column {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.viewport-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}

@media (max-width: 1024px) {
  .console-shell {
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .workspace-row {
    flex-direction: column;
  }

  .viewport-area {
    height: 55vh;
    min-height: 360px;
  }
}
</style>