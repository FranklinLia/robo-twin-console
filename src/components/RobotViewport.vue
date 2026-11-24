<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { JointState } from '../types/robot';

const props = defineProps<{
  joints: JointState[];
}>();

const containerRef = ref<HTMLDivElement | null>(null);

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let animationFrameId: number;

// 存储各个可动关节的 Three.js Group 引用，便于高频更新姿态
const jointNodes: Record<string, THREE.Group> = {};

const initScene = () => {
  if (!containerRef.value) return;
  const width = containerRef.value.clientWidth;
  const height = containerRef.value.clientHeight;

  // 1. 场景与工业暗黑背景
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.fog = new THREE.Fog(0x0f172a, 10, 30);

  // 2. 相机（ROS 习惯 Z 轴向上，此处使用标准 Three.js Y 轴向上，加载 URDF 时再做旋转适配）
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(3, 2.5, 3.5);

  // 3. 渲染器
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  containerRef.value.appendChild(renderer.domElement);

  // 4. 控制器
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 1, 0);

  // 5. 灯光与辅助参考系
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 8, 5);
  dirLight.castShadow = true;
  scene.add(dirLight);

  const gridHelper = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
  scene.add(gridHelper);

  const axesHelper = new THREE.AxesHelper(1);
  scene.add(axesHelper);

  buildMockRobotArm();
  animate();
};

// 构建层级运动学链（Parent -> Child 嵌套结构，模拟 URDF 关节继承关系）
const buildMockRobotArm = () => {
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.3 });
  const linkMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.4, roughness: 0.4 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness: 0.7, roughness: 0.2 });

  // 底座
  const baseMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.2, 32), baseMat);
  baseMesh.position.y = 0.1;
  scene.add(baseMesh);

  // Joint 1: 底座回转 (绕 Y 轴)
  const j1 = new THREE.Group();
  j1.position.y = 0.2;
  baseMesh.add(j1);
  jointNodes['joint_1'] = j1;

  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 24), jointMat);
  shoulder.position.y = 0.15;
  j1.add(shoulder);

  // Joint 2: 大臂俯仰 (绕 Z 轴)
  const j2 = new THREE.Group();
  j2.position.y = 0.3;
  j1.add(j2);
  jointNodes['joint_2'] = j2;

  const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.0, 0.18), linkMat);
  upperArm.position.y = 0.5;
  j2.add(upperArm);

  // Joint 3: 小臂俯仰 (绕 Z 轴)
  const j3 = new THREE.Group();
  j3.position.y = 1.0;
  j2.add(j3);
  jointNodes['joint_3'] = j3;

  const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.8, 0.14), linkMat);
  foreArm.position.y = 0.4;
  j3.add(foreArm);

  // Joint 4: 腕部旋转 (绕 Y 轴)
  const j4 = new THREE.Group();
  j4.position.y = 0.8;
  j3.add(j4);
  jointNodes['joint_4'] = j4;

  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.25, 16), jointMat);
  wrist.position.y = 0.125;
  j4.add(wrist);
};

// 同步外部传入的关节弧度到 3D 节点
const syncJointTransforms = () => {
  props.joints.forEach((joint) => {
    const node = jointNodes[joint.name];
    if (!node) return;
    if (joint.name === 'joint_1' || joint.name === 'joint_4') {
      node.rotation.y = joint.angle;
    } else {
      node.rotation.z = joint.angle;
    }
  });
};

watch(() => props.joints, syncJointTransforms, { deep: true });

const animate = () => {
  animationFrameId = requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
};

const handleResize = () => {
  if (!containerRef.value || !camera || !renderer) return;
  const width = containerRef.value.clientWidth;
  const height = containerRef.value.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
};

onMounted(() => {
  initScene();
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  cancelAnimationFrame(animationFrameId);
  controls?.dispose();
  renderer?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="viewport-container"></div>
</template>

<style scoped>
.viewport-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>