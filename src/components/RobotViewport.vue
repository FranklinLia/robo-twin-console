<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { URDFRobot } from 'urdf-loader';
import {
  DEFAULT_URDF_MODEL_NAME,
  FALLBACK_MOCK_MODEL_NAME,
  UR5_JOINT_MAPPING,
} from '../config/jointMapping';
import { generateWorkspacePointCloud } from '../services/kinematics';
import {
  applyJointsToUrdf,
  loadUrdfRobot,
  resolvePickedMockObject,
  resolvePickedUrdfObject,
} from '../services/urdfRobotLoader';
import { useRobotStore } from '../stores/robot';
import type { CameraPreset } from '../types/robot';

interface SemanticLabelCoord {
  id: string;
  label: string;
  x: number;
  y: number;
  visible: boolean;
  isHeld: boolean;
}

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

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let pmremGenerator: THREE.PMREMGenerator | null = null;
let envRenderTarget: THREE.WebGLRenderTarget | null = null;
let gridHelper: THREE.GridHelper | null = null;
let axesHelper: THREE.AxesHelper;
let shadowFloor: THREE.Mesh;
let dirLight: THREE.DirectionalLight;
let robotContainer: THREE.Group;
let trajectoryGroup: THREE.Group;
let actionPreviewGroup: THREE.Group;
let semanticGroup: THREE.Group;
let workspaceInstancedMesh: THREE.InstancedMesh | null = null;
let toolAxesHelper: THREE.AxesHelper | null = null;
let toolTargetNode: THREE.Object3D | null = null;

// 复用的轨迹/标记共享几何体与材质
let sharedWaypointGeom: THREE.SphereGeometry | null = null;
let sharedWaypointMat: THREE.MeshBasicMaterial | null = null;
let sharedCursorGeom: THREE.SphereGeometry | null = null;
let sharedCursorMat: THREE.MeshBasicMaterial | null = null;

const semanticMeshMap = new Map<string, THREE.Group>();

let resizeObserver: ResizeObserver | null = null;
let renderRafId = 0;
let renderRequested = false;

let activeUrdfRobot: URDFRobot | null = null;
const mockJointNodes: Record<string, THREE.Group> = {};
const mockLinkRoots: Record<string, THREE.Object3D> = {};

const _toolWorldPos = new THREE.Vector3();
const _projVec = new THREE.Vector3();

interface HighlightRecord {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  clonedMaterial: THREE.Material | THREE.Material[];
}
let highlightedMeshes: HighlightRecord[] = [];

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let pointerDownPos = { x: 0, y: 0 };

const toDeg = (rad: number) => (rad * (180 / Math.PI)).toFixed(1);
const pickedDisplay = computed(() => pickedJointInfo.value);

/**
 * 按需渲染调度器：仅在相机阻尼未收敛、模型状态变更或窗口尺寸变化时触发下一帧渲染
 */
const requestRender = () => {
  if (!renderer || !scene || !camera) return;
  renderRequested = true;
  if (renderRafId !== 0) return;
  renderRafId = requestAnimationFrame(renderFrame);
};

const renderFrame = () => {
  renderRafId = 0;
  if (!renderer || !scene || !camera || !controls) return;

  renderRequested = false;
  const controlsStillMoving = controls.update();
  updateSemanticScreenLabels();
  renderer.render(scene, camera);

  if (controlsStillMoving || renderRequested) {
    renderRafId = requestAnimationFrame(renderFrame);
  }
};

const clearHighlight = () => {
  for (const record of highlightedMeshes) {
    record.mesh.material = record.originalMaterial;
    if (Array.isArray(record.clonedMaterial)) {
      record.clonedMaterial.forEach((m) => m.dispose());
    } else {
      record.clonedMaterial.dispose();
    }
  }
  highlightedMeshes = [];
};

const createHighlightedMaterial = (mat: THREE.Material): THREE.Material => {
  const cloned = mat.clone();
  if ('emissive' in cloned && cloned.emissive instanceof THREE.Color) {
    cloned.emissive.setHex(0x38bdf8);
    if ('emissiveIntensity' in cloned) {
      (cloned as THREE.MeshStandardMaterial).emissiveIntensity = 0.5;
    }
  }
  return cloned;
};

const collectOwnLinkMeshes = (root: THREE.Object3D, out: THREE.Mesh[]) => {
  for (const child of root.children) {
    const isChildUrdfJoint = Boolean((child as { isURDFJoint?: boolean }).isURDFJoint);
    const isChildMockJoint = Boolean(child.userData?.storeJointName);
    if (isChildUrdfJoint || isChildMockJoint) {
      continue;
    }
    if ((child as THREE.Mesh).isMesh) {
      out.push(child as THREE.Mesh);
    }
    collectOwnLinkMeshes(child, out);
  }
};

const applyHighlightOnRoot = (root: THREE.Object3D | null) => {
  clearHighlight();
  if (!root) {
    requestRender();
    return;
  }

  const meshes: THREE.Mesh[] = [];
  if ((root as THREE.Mesh).isMesh) {
    meshes.push(root as THREE.Mesh);
  }
  collectOwnLinkMeshes(root, meshes);

  for (const mesh of meshes) {
    const originalMaterial = mesh.material;
    const clonedMaterial = Array.isArray(originalMaterial)
      ? originalMaterial.map(createHighlightedMaterial)
      : createHighlightedMaterial(originalMaterial);

    mesh.material = clonedMaterial;
    highlightedMeshes.push({ mesh, originalMaterial, clonedMaterial });
  }
  requestRender();
};

const disposeMaterialWithTextures = (mat: THREE.Material | undefined | null) => {
  if (!mat) return;
  const record = mat as unknown as Record<string, unknown>;
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
    const tex = record[key];
    if (tex && typeof (tex as THREE.Texture).dispose === 'function') {
      (tex as THREE.Texture).dispose();
    }
  }
  mat.dispose();
};

const disposeObjectTree = (root: THREE.Object3D, skipSharedResources = false) => {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      if (
        skipSharedResources &&
        (mesh.geometry === sharedWaypointGeom || mesh.geometry === sharedCursorGeom)
      ) {
        return;
      }
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => disposeMaterialWithTextures(m));
      } else {
        disposeMaterialWithTextures(mesh.material);
      }
    } else if ((obj as THREE.Line).isLine) {
      const line = obj as THREE.Line;
      line.geometry?.dispose();
      if (Array.isArray(line.material)) {
        line.material.forEach((m) => disposeMaterialWithTextures(m));
      } else {
        disposeMaterialWithTextures(line.material);
      }
    }
  });
};

const clearRobotContainer = () => {
  clearHighlight();
  if (toolAxesHelper) {
    toolAxesHelper.parent?.remove(toolAxesHelper);
    toolAxesHelper.dispose();
    toolAxesHelper = null;
  }
  toolTargetNode = null;
  activeUrdfRobot = null;
  Object.keys(mockJointNodes).forEach((k) => delete mockJointNodes[k]);
  Object.keys(mockLinkRoots).forEach((k) => delete mockLinkRoots[k]);

  while (robotContainer.children.length > 0) {
    const child = robotContainer.children[0];
    robotContainer.remove(child);
    disposeObjectTree(child);
  }
};

const attachToolAxes = (target: THREE.Object3D | null) => {
  if (!target) return;
  toolTargetNode = target;
  toolAxesHelper = new THREE.AxesHelper(0.14);
  toolAxesHelper.visible = viewportSettings.value.showToolAxes;
  target.add(toolAxesHelper);
};

const buildFallbackMockRobot = () => {
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.65, roughness: 0.35 });
  const linkMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.45, roughness: 0.4 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness: 0.7, roughness: 0.25 });

  const root = new THREE.Group();
  root.name = 'mock-fallback-robot';

  const baseMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.08, 32), baseMat);
  baseMesh.position.y = 0.04;
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;
  root.add(baseMesh);

  const j1 = new THREE.Group();
  j1.position.y = 0.08;
  j1.userData = { storeJointName: 'joint_1', linkName: 'shoulder_link', axis: 'y' };
  root.add(j1);
  mockJointNodes['joint_1'] = j1;
  mockLinkRoots['joint_1'] = j1;

  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 24), jointMat);
  shoulder.position.y = 0.06;
  shoulder.castShadow = true;
  j1.add(shoulder);

  const j2 = new THREE.Group();
  j2.position.set(0, 0.12, 0);
  j2.userData = { storeJointName: 'joint_2', linkName: 'upper_arm_link', axis: 'z' };
  j1.add(j2);
  mockJointNodes['joint_2'] = j2;
  mockLinkRoots['joint_2'] = j2;

  const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.42, 0.075), linkMat);
  upperArm.position.y = 0.21;
  upperArm.castShadow = true;
  j2.add(upperArm);

  const j3 = new THREE.Group();
  j3.position.set(0, 0.42, 0);
  j3.userData = { storeJointName: 'joint_3', linkName: 'forearm_link', axis: 'z' };
  j2.add(j3);
  mockJointNodes['joint_3'] = j3;
  mockLinkRoots['joint_3'] = j3;

  const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.06), linkMat);
  foreArm.position.y = 0.18;
  foreArm.castShadow = true;
  j3.add(foreArm);

  const j4 = new THREE.Group();
  j4.position.set(0, 0.36, 0);
  j4.userData = { storeJointName: 'joint_4', linkName: 'wrist_1_link', axis: 'z' };
  j3.add(j4);
  mockJointNodes['joint_4'] = j4;
  mockLinkRoots['joint_4'] = j4;

  const wrist1 = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.09, 18), jointMat);
  wrist1.position.y = 0.045;
  wrist1.castShadow = true;
  j4.add(wrist1);

  const j5 = new THREE.Group();
  j5.position.set(0, 0.09, 0);
  j5.userData = { storeJointName: 'joint_5', linkName: 'wrist_2_link', axis: 'y' };
  j4.add(j5);
  mockJointNodes['joint_5'] = j5;
  mockLinkRoots['joint_5'] = j5;

  const wrist2 = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.08, 18), baseMat);
  wrist2.position.y = 0.04;
  wrist2.castShadow = true;
  j5.add(wrist2);

  const j6 = new THREE.Group();
  j6.position.set(0, 0.08, 0);
  j6.userData = { storeJointName: 'joint_6', linkName: 'wrist_3_link', axis: 'z' };
  j5.add(j6);
  mockJointNodes['joint_6'] = j6;
  mockLinkRoots['joint_6'] = j6;

  const flange = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.035), jointMat);
  flange.position.y = 0.02;
  flange.castShadow = true;
  j6.add(flange);

  const mockTool = new THREE.Group();
  mockTool.position.set(0, 0.04, 0);
  j6.add(mockTool);
  attachToolAxes(mockTool);

  robotContainer.add(root);
};

const syncSemanticSceneMeshes = () => {
  if (!semanticGroup) return;
  semanticGroup.visible = viewportSettings.value.showSemantics;

  if (semanticMeshMap.size === 0) {
    const sharedRingGeom = new THREE.RingGeometry(0.018, 0.026, 24);
    const sharedRingMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });

    for (const obj of sceneObjects.value) {
      const group = new THREE.Group();
      group.name = `semantic-${obj.id}`;

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(obj.color),
        metalness: 0.25,
        roughness: 0.45,
      });

      let bodyMesh: THREE.Mesh;
      if (obj.geometry === 'box') {
        bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), mat);
      } else if (obj.geometry === 'cylinder') {
        bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.085, 24), mat);
      } else {
        bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.024, 0.14), mat);
      }
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      group.add(bodyMesh);

      const ring = new THREE.Mesh(sharedRingGeom.clone(), sharedRingMat.clone());
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(obj.graspOffset[0], obj.graspOffset[1], obj.graspOffset[2]);
      group.add(ring);

      semanticGroup.add(group);
      semanticMeshMap.set(obj.id, group);
    }

    sharedRingGeom.dispose();
    sharedRingMat.dispose();
  }

  for (const obj of sceneObjects.value) {
    const group = semanticMeshMap.get(obj.id);
    if (!group) continue;
    if (heldObjectId.value === obj.id && toolTargetNode) {
      toolTargetNode.getWorldPosition(_toolWorldPos);
      group.position.set(
        _toolWorldPos.x,
        Math.max(0.04, _toolWorldPos.y - 0.035),
        _toolWorldPos.z
      );
    } else {
      group.position.set(obj.position[0], obj.position[1], obj.position[2]);
    }
  }
  requestRender();
};

const updateSemanticScreenLabels = () => {
  if (!viewportSettings.value.showSemantics || !camera || !containerRef.value) {
    if (semanticLabels.value.length > 0) semanticLabels.value = [];
    return;
  }

  const width = containerRef.value.clientWidth;
  const height = containerRef.value.clientHeight;
  if (width === 0 || height === 0) return;

  const nextLabels: SemanticLabelCoord[] = [];
  for (const obj of sceneObjects.value) {
    const group = semanticMeshMap.get(obj.id);
    if (!group) continue;
    _projVec.copy(group.position);
    _projVec.y += obj.graspOffset[1] + 0.05;
    _projVec.project(camera);

    const visible = _projVec.z >= -1 && _projVec.z <= 1;
    const x = ((_projVec.x + 1) / 2) * width;
    const y = ((-_projVec.y + 1) / 2) * height;
    nextLabels.push({
      id: obj.id,
      label: obj.label,
      x,
      y,
      visible,
      isHeld: heldObjectId.value === obj.id,
    });
  }
  semanticLabels.value = nextLabels;
};

const syncJointTransforms = () => {
  if (activeUrdfRobot) {
    applyJointsToUrdf(activeUrdfRobot, joints.value);
  } else {
    for (const joint of joints.value) {
      const node = mockJointNodes[joint.name];
      if (!node) continue;
      if (node.userData.axis === 'y') {
        node.rotation.y = joint.angle;
      } else {
        node.rotation.z = -joint.angle;
      }
    }
  }

  if (toolTargetNode && robotContainer) {
    robotContainer.updateMatrixWorld(true);
    toolTargetNode.getWorldPosition(_toolWorldPos);
    robotStore.setThreeWorldToolPos([_toolWorldPos.x, _toolWorldPos.y, _toolWorldPos.z]);
  }
  syncSemanticSceneMeshes();
  requestRender();
};

const syncHighlightFromStore = () => {
  const jointName = selectedJointName.value;
  if (!jointName) {
    clearHighlight();
    requestRender();
    return;
  }

  if (activeUrdfRobot) {
    const mapping = UR5_JOINT_MAPPING.find((m) => m.storeJointName === jointName);
    const linkObj = mapping ? activeUrdfRobot.links[mapping.linkName] : undefined;
    if (linkObj) {
      applyHighlightOnRoot(linkObj);
      return;
    }
  }

  const mockNode = mockLinkRoots[jointName];
  if (mockNode) {
    applyHighlightOnRoot(mockNode);
  }
};

/**
 * 阶段 5：使用 InstancedMesh 渲染 2400 个工作空间采样点（单 Draw Call + 共享几何体）
 */
const ensureWorkspaceCloud = () => {
  if (!scene) return;
  if (!viewportSettings.value.showWorkspace) {
    if (workspaceInstancedMesh) workspaceInstancedMesh.visible = false;
    requestRender();
    return;
  }

  if (!workspaceInstancedMesh) {
    const limits = joints.value.map((j) => ({ min: j.min, max: j.max }));
    const data = generateWorkspacePointCloud(limits, 2400);
    robotStore.setWorkspaceStats(data.count, data.maxReachMeters);

    const geom = new THREE.IcosahedronGeometry(0.0085, 0);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });

    const instMesh = new THREE.InstancedMesh(geom, mat, data.count);
    instMesh.name = 'workspace-instanced-cloud';
    const dummyMatrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (let i = 0; i < data.count; i++) {
      const idx = i * 3;
      dummyMatrix.makeTranslation(
        data.positions[idx],
        data.positions[idx + 1],
        data.positions[idx + 2]
      );
      instMesh.setMatrixAt(i, dummyMatrix);
      color.setRGB(data.colors[idx], data.colors[idx + 1], data.colors[idx + 2]);
      instMesh.setColorAt(i, color);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

    workspaceInstancedMesh = instMesh;
    scene.add(workspaceInstancedMesh);
  }

  workspaceInstancedMesh.visible = true;
  requestRender();
};

const rebuildTrajectoryOverlay = () => {
  if (!trajectoryGroup) return;

  while (trajectoryGroup.children.length > 0) {
    const child = trajectoryGroup.children[0];
    trajectoryGroup.remove(child);
    disposeObjectTree(child, true);
  }

  if (waypoints.value.length > 0 && sharedWaypointGeom && sharedWaypointMat) {
    for (const wp of waypoints.value) {
      const marker = new THREE.Mesh(sharedWaypointGeom, sharedWaypointMat);
      marker.position.set(wp.threePosition[0], wp.threePosition[1], wp.threePosition[2]);
      trajectoryGroup.add(marker);
    }
  }

  if (plannedTrajectory.value.length >= 2) {
    const linePoints = plannedTrajectory.value.map(
      (pt) => new THREE.Vector3(pt.threePosition[0], pt.threePosition[1], pt.threePosition[2])
    );
    const lineGeom = new THREE.BufferGeometry().setFromPoints(linePoints);
    const lineColor = trajectoryMode.value === 'CARTESIAN_LINEAR' ? 0x34d399 : 0x38bdf8;
    const lineMat = new THREE.LineBasicMaterial({ color: lineColor });
    const line = new THREE.Line(lineGeom, lineMat);
    trajectoryGroup.add(line);

    if ((playbackState.value !== 'IDLE' || playbackIndex.value > 0) && sharedCursorGeom && sharedCursorMat) {
      const activePt = plannedTrajectory.value[playbackIndex.value];
      if (activePt) {
        const cursorMesh = new THREE.Mesh(sharedCursorGeom, sharedCursorMat);
        cursorMesh.position.set(
          activePt.threePosition[0],
          activePt.threePosition[1],
          activePt.threePosition[2]
        );
        trajectoryGroup.add(cursorMesh);
      }
    }
  }
  requestRender();
};

const rebuildActionPreviewOverlay = () => {
  if (!actionPreviewGroup) return;

  while (actionPreviewGroup.children.length > 0) {
    const child = actionPreviewGroup.children[0];
    actionPreviewGroup.remove(child);
    disposeObjectTree(child, true);
  }

  if (
    previewTrajectory.value.length >= 2 &&
    (actionExecutionStatus.value === 'PREVIEW' || actionExecutionStatus.value === 'EXECUTING')
  ) {
    const pts = previewTrajectory.value.map(
      (pt) => new THREE.Vector3(pt.threePosition[0], pt.threePosition[1], pt.threePosition[2])
    );
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: actionExecutionStatus.value === 'PREVIEW' ? 0xfbbf24 : 0x34d399,
    });
    actionPreviewGroup.add(new THREE.Line(geom, mat));

    const endPt = pts[pts.length - 1];
    if (sharedWaypointGeom && sharedWaypointMat) {
      const targetDot = new THREE.Mesh(sharedWaypointGeom, sharedWaypointMat);
      targetDot.position.copy(endPt);
      actionPreviewGroup.add(targetDot);
    }

    if (actionExecutionStatus.value === 'EXECUTING' && sharedCursorGeom && sharedCursorMat) {
      const curPt = pts[Math.min(actionFrameIndex.value, pts.length - 1)];
      const execDot = new THREE.Mesh(sharedCursorGeom, sharedCursorMat);
      execDot.position.copy(curPt);
      actionPreviewGroup.add(execDot);
    }
  }
  requestRender();
};

const applySceneTheme = () => {
  if (!scene) return;
  const isLight = theme.value === 'light';
  const bgHex = isLight ? 0xeef2f6 : 0x0b1220;
  scene.background = new THREE.Color(bgHex);
  scene.fog = new THREE.Fog(bgHex, 6, 18);

  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.dispose();
  }
  gridHelper = new THREE.GridHelper(
    4,
    20,
    isLight ? 0x94a3b8 : 0x334155,
    isLight ? 0xcbd5e1 : 0x1e293b
  );
  gridHelper.visible = viewportSettings.value.showGrid;
  scene.add(gridHelper);
  requestRender();
};

const applyCameraPreset = (preset: CameraPreset) => {
  if (!camera || !controls) return;
  if (preset === 'FRONT') {
    camera.position.set(0, 0.55, 2.0);
    controls.target.set(0, 0.42, 0);
  } else if (preset === 'SIDE') {
    camera.position.set(2.0, 0.55, 0);
    controls.target.set(0, 0.42, 0);
  } else if (preset === 'TOP') {
    camera.position.set(0, 2.2, 0.01);
    controls.target.set(0, 0.25, 0);
  } else {
    camera.position.set(1.45, 1.15, 1.55);
    controls.target.set(0, 0.42, 0);
  }
  controls.update();
  requestRender();
};

const loadRobotModel = async (targetUrl: string) => {
  if (!robotContainer) return;
  isLoadingModel.value = true;
  clearRobotContainer();

  try {
    const { robot, rootGroup } = await loadUrdfRobot(targetUrl);
    activeUrdfRobot = robot;
    robotContainer.add(rootGroup);
    attachToolAxes(robot.links['tool0'] ?? robot.links['wrist_3_link'] ?? null);
    robotStore.setModelStatus('URDF', DEFAULT_URDF_MODEL_NAME, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[RobotViewport] URDF 加载失败，降级为 Mock 模型:', message);
    buildFallbackMockRobot();
    robotStore.setModelStatus(
      'MOCK_FALLBACK',
      FALLBACK_MOCK_MODEL_NAME,
      `URDF 加载失败 (${message})，已自动降级为本地 Mock 机械臂`
    );
  } finally {
    isLoadingModel.value = false;
    syncJointTransforms();
    syncHighlightFromStore();
    requestRender();
  }
};

const applyViewportSettings = () => {
  if (gridHelper) gridHelper.visible = viewportSettings.value.showGrid;
  if (axesHelper) axesHelper.visible = viewportSettings.value.showAxes;
  if (toolAxesHelper) toolAxesHelper.visible = viewportSettings.value.showToolAxes;
  if (shadowFloor) shadowFloor.visible = viewportSettings.value.showShadows;
  if (dirLight) dirLight.castShadow = viewportSettings.value.showShadows;
  if (renderer) renderer.shadowMap.enabled = viewportSettings.value.showShadows;
  if (semanticGroup) semanticGroup.visible = viewportSettings.value.showSemantics;
  ensureWorkspaceCloud();
  requestRender();
};

const handlePointerDown = (event: PointerEvent) => {
  pointerDownPos = { x: event.clientX, y: event.clientY };
};

const handlePointerUp = (event: PointerEvent) => {
  if (!renderer || !camera || !robotContainer) return;

  const dx = event.clientX - pointerDownPos.x;
  const dy = event.clientY - pointerDownPos.y;
  if (Math.hypot(dx, dy) > 5) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(robotContainer.children, true);

  if (hits.length === 0) {
    robotStore.selectJoint(null, null);
    clearHighlight();
    requestRender();
    return;
  }

  const hitMesh = hits[0].object;
  const match = activeUrdfRobot
    ? resolvePickedUrdfObject(hitMesh)
    : resolvePickedMockObject(hitMesh);

  if (match) {
    robotStore.selectJoint(match.storeJointName, match.linkName);
    applyHighlightOnRoot(match.highlightRoot);
  } else {
    robotStore.selectJoint(null, null);
    clearHighlight();
    requestRender();
  }
};

const initScene = () => {
  if (!containerRef.value) return;
  const width = containerRef.value.clientWidth || 1;
  const height = containerRef.value.clientHeight || 1;

  sharedWaypointGeom = new THREE.SphereGeometry(0.014, 14, 14);
  sharedWaypointMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  sharedCursorGeom = new THREE.SphereGeometry(0.018, 14, 14);
  sharedCursorMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e });

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 50);
  camera.position.set(1.45, 1.15, 1.55);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = viewportSettings.value.showShadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  containerRef.value.appendChild(renderer.domElement);

  pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  envRenderTarget = pmremGenerator.fromScene(roomEnv, 0.04);
  scene.environment = envRenderTarget.texture;
  roomEnv.dispose();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.5;
  controls.maxDistance = 6;
  controls.target.set(0, 0.42, 0);
  controls.addEventListener('change', requestRender);

  const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.55);
  scene.add(hemiLight);

  dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(2.5, 4.0, 2.5);
  dirLight.castShadow = viewportSettings.value.showShadows;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 10;
  dirLight.shadow.camera.left = -1.5;
  dirLight.shadow.camera.right = 1.5;
  dirLight.shadow.camera.top = 1.5;
  dirLight.shadow.camera.bottom = -1.5;
  dirLight.shadow.bias = -0.0004;
  scene.add(dirLight);

  const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
  rimLight.position.set(-2.5, 2.0, -2.5);
  scene.add(rimLight);

  shadowFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.ShadowMaterial({ opacity: 0.34 })
  );
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.position.y = 0.0005;
  shadowFloor.receiveShadow = true;
  scene.add(shadowFloor);

  axesHelper = new THREE.AxesHelper(0.35);
  axesHelper.position.y = 0.002;
  scene.add(axesHelper);

  robotContainer = new THREE.Group();
  robotContainer.name = 'robot-stage';
  scene.add(robotContainer);

  trajectoryGroup = new THREE.Group();
  trajectoryGroup.name = 'trajectory-overlay';
  scene.add(trajectoryGroup);

  actionPreviewGroup = new THREE.Group();
  actionPreviewGroup.name = 'action-preview-overlay';
  scene.add(actionPreviewGroup);

  semanticGroup = new THREE.Group();
  semanticGroup.name = 'semantic-objects';
  scene.add(semanticGroup);

  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointerup', handlePointerUp);

  applySceneTheme();
  applyViewportSettings();
  syncSemanticSceneMeshes();
  rebuildTrajectoryOverlay();
  rebuildActionPreviewOverlay();
  void loadRobotModel(urdfUrl.value);
  requestRender();
};

watch(joints, syncJointTransforms, { deep: true });
watch([sceneObjects, heldObjectId], syncSemanticSceneMeshes, { deep: true });
watch(urdfUrl, (newUrl) => {
  void loadRobotModel(newUrl);
});
watch(viewportSettings, applyViewportSettings, { deep: true });
watch(theme, applySceneTheme);
watch(cameraResetVersion, () => applyCameraPreset(cameraPreset.value));
watch(selectedJointName, syncHighlightFromStore);
watch([plannedTrajectory, waypoints, trajectoryMode, playbackState, playbackIndex], rebuildTrajectoryOverlay, {
  deep: true,
});
watch([previewTrajectory, actionExecutionStatus, actionFrameIndex], rebuildActionPreviewOverlay, {
  deep: true,
});

const handleResize = () => {
  if (!containerRef.value || !camera || !renderer) return;
  const width = containerRef.value.clientWidth;
  const height = containerRef.value.clientHeight;
  if (width === 0 || height === 0) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  requestRender();
};

onMounted(() => {
  initScene();
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.value);
  }
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  resizeObserver?.disconnect();
  if (renderRafId !== 0) {
    cancelAnimationFrame(renderRafId);
    renderRafId = 0;
  }

  if (controls) {
    controls.removeEventListener('change', requestRender);
    controls.dispose();
  }

  if (renderer?.domElement) {
    renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
    renderer.domElement.removeEventListener('pointerup', handlePointerUp);
  }

  clearRobotContainer();
  if (workspaceInstancedMesh) {
    workspaceInstancedMesh.geometry.dispose();
    (workspaceInstancedMesh.material as THREE.Material).dispose();
    workspaceInstancedMesh = null;
  }
  if (trajectoryGroup) disposeObjectTree(trajectoryGroup, true);
  if (actionPreviewGroup) disposeObjectTree(actionPreviewGroup, true);
  if (semanticGroup) disposeObjectTree(semanticGroup);
  semanticMeshMap.clear();

  sharedWaypointGeom?.dispose();
  sharedWaypointMat?.dispose();
  sharedCursorGeom?.dispose();
  sharedCursorMat?.dispose();

  shadowFloor?.geometry.dispose();
  disposeMaterialWithTextures(shadowFloor?.material as THREE.Material | undefined);
  gridHelper?.dispose();
  axesHelper?.dispose();
  envRenderTarget?.dispose();
  pmremGenerator?.dispose();
  renderer?.dispose();
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
  backdrop-filter: blur(6px);
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
  backdrop-filter: blur(8px);
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
  backdrop-filter: blur(6px);
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
  backdrop-filter: blur(6px);
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
  backdrop-filter: blur(8px);
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