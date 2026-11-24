<script setup lang="ts">
import { ref } from 'vue';
import RobotViewport from './components/RobotViewport.vue';
import type { JointState } from './types/robot';

const joints = ref<JointState[]>([
  { name: 'joint_1', label: 'J1 底座回转 (Yaw)', angle: 0, min: -3.14, max: 3.14 },
  { name: 'joint_2', label: 'J2 大臂俯仰 (Pitch)', angle: 0.3, min: -1.57, max: 1.57 },
  { name: 'joint_3', label: 'J3 小臂俯仰 (Elbow)', angle: -0.6, min: -2.0, max: 2.0 },
  { name: 'joint_4', label: 'J4 腕部旋转 (Roll)', angle: 0, min: -3.14, max: 3.14 },
]);

const resetPose = () => {
  joints.value.forEach((j) => (j.angle = 0));
};
</script>

<template>
  <div class="console-layout">
    <main class="viewport-area">
      <RobotViewport :joints="joints" />
    </main>

    <aside class="control-sidebar">
      <div class="panel-header">
        <h2>ROBO-TWIN 控制台</h2>
        <span class="status-badge">LOCAL SIM</span>
      </div>

      <div class="joint-list">
        <div v-for="joint in joints" :key="joint.name" class="joint-item">
          <div class="joint-meta">
            <span>{{ joint.label }}</span>
            <code>{{ (joint.angle * (180 / Math.PI)).toFixed(1) }}°</code>
          </div>
          <input
            type="range"
            v-model.number="joint.angle"
            :min="joint.min"
            :max="joint.max"
            step="0.01"
          />
        </div>
      </div>

      <button class="reset-btn" @click="resetPose">归零姿态 (Home Pose)</button>
    </aside>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
body {
  background: #090d16;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.console-layout {
  display: flex;
  width: 100vw;
  height: 100vh;
}
.viewport-area {
  flex: 1;
  position: relative;
}
.control-sidebar {
  width: 320px;
  background: #1e293b;
  border-left: 1px solid #334155;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #334155;
  padding-bottom: 12px;
}
.panel-header h2 {
  font-size: 16px;
  color: #38bdf8;
}
.status-badge {
  font-size: 11px;
  background: #065f46;
  color: #34d399;
  padding: 2px 6px;
  border-radius: 4px;
}
.joint-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.joint-meta {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 6px;
}
.joint-item input[type='range'] {
  width: 100%;
  accent-color: #38bdf8;
  cursor: pointer;
}
.reset-btn {
  margin-top: auto;
  padding: 10px;
  background: #0284c7;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: bold;
}
.reset-btn:hover {
  background: #0369a1;
}
</style>