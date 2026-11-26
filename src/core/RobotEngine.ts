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
  applyJointArrayToUrdf,
  loadUrdfRobot,
  resolvePickedMockObject,
  resolvePickedUrdfObject,
} from '../services/urdfRobotLoader';
import type {
  ActionExecutionStatus,
  CameraPreset,
  JointState,
  SceneObjectItem,
  TeachWaypoint,
  ThemeMode,
  TrajectoryMode,
  TrajectoryPoint,
  ViewportSettings,
} from '../types/robot';
import type { MotionBuffer } from './MotionBuffer';
import type {
  RobotEngineCallbacks,
  RobotEngineInitOptions,
  SemanticLabelCoord,
} from './types';

interface HighlightRecord {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  clonedMaterial: THREE.Material | THREE.Material[];
}

interface CameraPresetPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'envMap',
  'lightMap',
  'specularMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'transmissionMap',
  'thicknessMap',
] as const;

const ORDERED_STORE_JOINTS = UR5_JOINT_MAPPING.map((m) => m.storeJointName);
const ORDERED_URDF_JOINTS = UR5_JOINT_MAPPING.map((m) => m.urdfJointName);

function detectSoftwareWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

/**
 * 纯 TypeScript 3D 机器人数字孪生渲染引擎（零 Vue / Pinia 依赖）
 * 统一托管 Scene、PerspectiveCamera、WebGLRenderer、OrbitControls、
 * 60FPS Lerp 运动插值驱动及显存资源释放。
 */
export class RobotEngine {
  private readonly container: HTMLElement;
  private readonly motionBuffer: MotionBuffer;
  private readonly callbacks: RobotEngineCallbacks;
  private readonly isSoftwareGl: boolean;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;

  private pmremGenerator: THREE.PMREMGenerator | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private gridHelper: THREE.GridHelper | null = null;
  private readonly axesHelper: THREE.AxesHelper;
  private readonly shadowFloor: THREE.Mesh;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly dirLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;

  private readonly robotContainer: THREE.Group;
  private readonly trajectoryGroup: THREE.Group;
  private readonly actionPreviewGroup: THREE.Group;
  private readonly semanticGroup: THREE.Group;

  private workspaceInstancedMesh: THREE.InstancedMesh | null = null;
  private toolAxesHelper: THREE.AxesHelper | null = null;
  private toolTargetNode: THREE.Object3D | null = null;

  private sharedWaypointGeom: THREE.SphereGeometry | null = null;
  private sharedWaypointMat: THREE.MeshBasicMaterial | null = null;
  private sharedCursorGeom: THREE.SphereGeometry | null = null;
  private sharedCursorMat: THREE.MeshBasicMaterial | null = null;

  private readonly semanticMeshMap = new Map<string, THREE.Group>();
  private lastSemanticSnapshotKey = '';

  private activeUrdfRobot: URDFRobot | null = null;
  private readonly mockJointNodes: Record<string, THREE.Group> = {};
  private readonly mockLinkRoots: Record<string, THREE.Object3D> = {};
  private highlightedMeshes: HighlightRecord[] = [];

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private pointerDownPos = { x: 0, y: 0 };

  // 预分配的定长类型化数组与临时向量，消除 60FPS 渲染循环中的 GC 分配
  private readonly currentJointAngles: Float64Array;
  private readonly urdfScratchValues: Record<string, number> = {};
  private readonly _toolWorldPos = new THREE.Vector3();
  private readonly _projVec = new THREE.Vector3();
  private readonly _dummyMatrix = new THREE.Matrix4();
  private readonly _tempColor = new THREE.Color();

  private viewportSettings: ViewportSettings;
  private latestJoints: JointState[];
  private latestSceneObjects: SceneObjectItem[];
  private latestHeldObjectId: string | null;
  private selectedJointName: string | null;
  private currentTheme: ThemeMode;

  private cameraTransition: CameraPresetPose | null = null;
  private lastFrameTimestamp = 0;
  private lastToolReportTime = 0;

  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeMotion: (() => void) | null = null;
  private renderRafId = 0;
  private renderRequested = false;
  private loadGeneration = 0;
  private disposed = false;

  private readonly boundHandleResize: () => void;
  private readonly boundHandlePointerDown: (event: PointerEvent) => void;
  private readonly boundHandlePointerUp: (event: PointerEvent) => void;
  private readonly boundOnControlsChange: () => void;
  private readonly boundOnControlsStart: () => void;
  private readonly boundRenderFrame: (timestamp: number) => void;

  constructor(options: RobotEngineInitOptions) {
    this.container = options.container;
    this.motionBuffer = options.motionBuffer;
    this.callbacks = options.callbacks ?? {};
    this.isSoftwareGl = detectSoftwareWebGL();

    this.currentJointAngles = new Float64Array(this.motionBuffer.jointCount);
    for (let i = 0; i < this.currentJointAngles.length; i++) {
      this.currentJointAngles[i] = options.initialAngles[i] ?? 0;
    }

    this.viewportSettings = { ...options.viewportSettings };
    this.latestJoints = options.joints;
    this.latestSceneObjects = options.sceneObjects;
    this.latestHeldObjectId = options.heldObjectId;
    this.selectedJointName = options.selectedJointName;
    this.currentTheme = options.theme;

    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;

    this.sharedWaypointGeom = new THREE.SphereGeometry(0.014, 14, 14);
    this.sharedWaypointMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    this.sharedCursorGeom = new THREE.SphereGeometry(0.018, 14, 14);
    this.sharedCursorMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e });

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 50);
    this.camera.position.set(1.45, 1.15, 1.55);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.viewportSettings.showShadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.envRenderTarget = this.pmremGenerator.fromScene(roomEnv, 0.04);
    this.scene.environment = this.envRenderTarget.texture;
    roomEnv.dispose();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 6;
    this.controls.target.set(0, 0.42, 0);

    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.55);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.dirLight.position.set(2.5, 4.0, 2.5);
    this.dirLight.castShadow = this.viewportSettings.showShadows;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 10;
    this.dirLight.shadow.camera.left = -1.5;
    this.dirLight.shadow.camera.right = 1.5;
    this.dirLight.shadow.camera.top = 1.5;
    this.dirLight.shadow.camera.bottom = -1.5;
    this.dirLight.shadow.bias = -0.0004;
    this.scene.add(this.dirLight);

    this.rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    this.rimLight.position.set(-2.5, 2.0, -2.5);
    this.scene.add(this.rimLight);

    this.shadowFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShadowMaterial({ opacity: 0.34 })
    );
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.position.y = 0.0005;
    this.shadowFloor.receiveShadow = true;
    this.scene.add(this.shadowFloor);

    this.axesHelper = new THREE.AxesHelper(0.35);
    this.axesHelper.position.y = 0.002;
    this.scene.add(this.axesHelper);

    this.robotContainer = new THREE.Group();
    this.robotContainer.name = 'robot-stage';
    this.scene.add(this.robotContainer);

    this.trajectoryGroup = new THREE.Group();
    this.trajectoryGroup.name = 'trajectory-overlay';
    this.scene.add(this.trajectoryGroup);

    this.actionPreviewGroup = new THREE.Group();
    this.actionPreviewGroup.name = 'action-preview-overlay';
    this.scene.add(this.actionPreviewGroup);

    this.semanticGroup = new THREE.Group();
    this.semanticGroup.name = 'semantic-objects';
    this.scene.add(this.semanticGroup);

    this.boundHandleResize = () => this.resize();
    this.boundHandlePointerDown = (e) => this.handlePointerDown(e);
    this.boundHandlePointerUp = (e) => this.handlePointerUp(e);
    this.boundOnControlsChange = () => this.requestRender();
    this.boundOnControlsStart = () => {
      this.cameraTransition = null;
    };
    this.boundRenderFrame = (ts) => this.renderFrame(ts);

    this.controls.addEventListener('change', this.boundOnControlsChange);
    this.controls.addEventListener('start', this.boundOnControlsStart);
    this.renderer.domElement.addEventListener('pointerdown', this.boundHandlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.boundHandlePointerUp);

    this.unsubscribeMotion = this.motionBuffer.subscribe(() => {
      this.requestRender();
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.boundHandleResize);
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener('resize', this.boundHandleResize);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.setTheme(this.currentTheme);
    this.applyViewportSettings(this.viewportSettings, this.latestJoints);
    this.syncSemanticObjects(this.latestSceneObjects, this.latestHeldObjectId);
    this.updateTrajectoryOverlay(
      options.waypoints,
      options.plannedTrajectory,
      options.trajectoryMode,
      options.playbackState,
      options.playbackIndex
    );
    this.updateActionPreviewOverlay(
      options.previewTrajectory,
      options.actionExecutionStatus,
      options.actionFrameIndex
    );
    void this.loadRobotModel(options.urdfUrl);
    this.requestRender();
  }

  /**
   * 按需 + 60FPS 插值渲染调度器
   */
  public requestRender(): void {
    if (this.disposed) return;
    this.renderRequested = true;
    if (this.renderRafId !== 0) return;
    this.renderRafId = requestAnimationFrame(this.boundRenderFrame);
  }

  private renderFrame(timestamp: number): void {
    this.renderRafId = 0;
    if (this.disposed) return;

    const dt =
      this.lastFrameTimestamp > 0
        ? Math.min((timestamp - this.lastFrameTimestamp) / 1000, 0.1)
        : 0.016;
    this.lastFrameTimestamp = timestamp;
    this.renderRequested = false;

    // 1. 从抗抖动环形缓冲区执行 60FPS Lerp 关节采样
    let motionStillInterpolating = false;
    if (this.motionBuffer.getCount() > 0) {
      motionStillInterpolating = this.motionBuffer.sample(timestamp, this.currentJointAngles);
    }
    this.applyJointRadians(this.currentJointAngles, timestamp);

    // 2. 相机预设阻尼过渡
    let transitionActive = false;
    if (this.cameraTransition) {
      const lambda = 12;
      this.camera.position.x = THREE.MathUtils.damp(
        this.camera.position.x,
        this.cameraTransition.position.x,
        lambda,
        dt
      );
      this.camera.position.y = THREE.MathUtils.damp(
        this.camera.position.y,
        this.cameraTransition.position.y,
        lambda,
        dt
      );
      this.camera.position.z = THREE.MathUtils.damp(
        this.camera.position.z,
        this.cameraTransition.position.z,
        lambda,
        dt
      );

      this.controls.target.x = THREE.MathUtils.damp(
        this.controls.target.x,
        this.cameraTransition.target.x,
        lambda,
        dt
      );
      this.controls.target.y = THREE.MathUtils.damp(
        this.controls.target.y,
        this.cameraTransition.target.y,
        lambda,
        dt
      );
      this.controls.target.z = THREE.MathUtils.damp(
        this.controls.target.z,
        this.cameraTransition.target.z,
        lambda,
        dt
      );

      const posDist = this.camera.position.distanceTo(this.cameraTransition.position);
      const targetDist = this.controls.target.distanceTo(this.cameraTransition.target);
      if (posDist < 0.002 && targetDist < 0.002) {
        this.camera.position.copy(this.cameraTransition.position);
        this.controls.target.copy(this.cameraTransition.target);
        this.cameraTransition = null;
      } else {
        transitionActive = true;
      }
    }

    const controlsStillMoving = this.controls.update();
    this.updateSemanticScreenLabels();
    this.renderer.render(this.scene, this.camera);

    if (
      controlsStillMoving ||
      transitionActive ||
      motionStillInterpolating ||
      this.renderRequested
    ) {
      this.renderRafId = requestAnimationFrame(this.boundRenderFrame);
    } else {
      this.lastFrameTimestamp = 0;
    }
  }

  private applyJointRadians(angles: Float64Array, timestamp: number): void {
    if (this.activeUrdfRobot) {
      applyJointArrayToUrdf(
        this.activeUrdfRobot,
        angles,
        ORDERED_URDF_JOINTS,
        this.urdfScratchValues
      );
    } else {
      for (let i = 0; i < ORDERED_STORE_JOINTS.length; i++) {
        const node = this.mockJointNodes[ORDERED_STORE_JOINTS[i]];
        if (!node) continue;
        const angle = angles[i] ?? 0;
        if (node.userData.axis === 'y') {
          node.rotation.y = angle;
        } else {
          node.rotation.z = -angle;
        }
      }
    }

    if (this.toolTargetNode) {
      this.robotContainer.updateMatrixWorld(true);
      this.toolTargetNode.getWorldPosition(this._toolWorldPos);

      // 将末端世界坐标回调至 Vue Store 节流到 10Hz（100ms），避免 60FPS 触发响应式重绘
      if (timestamp - this.lastToolReportTime >= 100) {
        this.lastToolReportTime = timestamp;
        this.callbacks.onToolWorldPosition?.([
          this._toolWorldPos.x,
          this._toolWorldPos.y,
          this._toolWorldPos.z,
        ]);
      }
    }

    if (this.latestHeldObjectId) {
      const heldGroup = this.semanticMeshMap.get(this.latestHeldObjectId);
      if (heldGroup && this.toolTargetNode) {
        heldGroup.position.set(
          this._toolWorldPos.x,
          Math.max(0.04, this._toolWorldPos.y - 0.035),
          this._toolWorldPos.z
        );
      }
    }
  }

  public resize(): void {
    if (this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.requestRender();
  }

  public setTheme(theme: ThemeMode): void {
    this.currentTheme = theme;
    if (this.disposed) return;
    const isLight = theme === 'light';
    const bgHex = isLight ? 0xeef2f6 : 0x0b1220;
    this.scene.background = new THREE.Color(bgHex);
    this.scene.fog = new THREE.Fog(bgHex, 6, 18);

    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.dispose();
    }
    this.gridHelper = new THREE.GridHelper(
      4,
      20,
      isLight ? 0x94a3b8 : 0x334155,
      isLight ? 0xcbd5e1 : 0x1e293b
    );
    this.gridHelper.visible = this.viewportSettings.showGrid;
    this.scene.add(this.gridHelper);
    this.requestRender();
  }

  public setCameraPreset(preset: CameraPreset): void {
    if (this.disposed) return;
    const pose: CameraPresetPose =
      preset === 'FRONT'
        ? { position: new THREE.Vector3(0, 0.55, 2.0), target: new THREE.Vector3(0, 0.42, 0) }
        : preset === 'SIDE'
          ? { position: new THREE.Vector3(2.0, 0.55, 0), target: new THREE.Vector3(0, 0.42, 0) }
          : preset === 'TOP'
            ? { position: new THREE.Vector3(0, 2.2, 0.01), target: new THREE.Vector3(0, 0.25, 0) }
            : { position: new THREE.Vector3(1.45, 1.15, 1.55), target: new THREE.Vector3(0, 0.42, 0) };

    if (this.isSoftwareGl) {
      this.cameraTransition = null;
      this.camera.position.copy(pose.position);
      this.controls.target.copy(pose.target);
      this.controls.update();
    } else {
      this.cameraTransition = pose;
    }
    this.requestRender();
  }

  public applyViewportSettings(settings: ViewportSettings, joints: JointState[]): void {
    this.viewportSettings = { ...settings };
    this.latestJoints = joints;
    if (this.disposed) return;

    if (this.gridHelper) this.gridHelper.visible = settings.showGrid;
    this.axesHelper.visible = settings.showAxes;
    if (this.toolAxesHelper) this.toolAxesHelper.visible = settings.showToolAxes;
    this.shadowFloor.visible = settings.showShadows;
    this.dirLight.castShadow = settings.showShadows;
    this.renderer.shadowMap.enabled = settings.showShadows;
    this.semanticGroup.visible = settings.showSemantics;

    this.ensureWorkspaceCloud(joints);
    this.updateSemanticScreenLabels();
    this.requestRender();
  }

  public async loadRobotModel(targetUrl: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.loadGeneration;
    this.callbacks.onModelLoadingChange?.(true);
    this.clearRobotContainer();

    try {
      const { robot, rootGroup } = await loadUrdfRobot(targetUrl);
      if (this.disposed || generation !== this.loadGeneration) {
        this.disposeObjectTree(rootGroup);
        return;
      }

      this.activeUrdfRobot = robot;
      this.robotContainer.add(rootGroup);
      this.attachToolAxes(robot.links['tool0'] ?? robot.links['wrist_3_link'] ?? null);
      this.callbacks.onModelStatusChange?.('URDF', DEFAULT_URDF_MODEL_NAME, null);
    } catch (err) {
      if (this.disposed || generation !== this.loadGeneration) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[RobotEngine] URDF 加载失败，降级为 Mock 模型:', message);
      this.buildFallbackMockRobot();
      this.callbacks.onModelStatusChange?.(
        'MOCK_FALLBACK',
        FALLBACK_MOCK_MODEL_NAME,
        `URDF 加载失败 (${message})，已自动降级为本地 Mock 机械臂`
      );
    } finally {
      if (!this.disposed && generation === this.loadGeneration) {
        this.callbacks.onModelLoadingChange?.(false);
        this.motionBuffer.getLatest(this.currentJointAngles);
        this.lastToolReportTime = 0;
        this.applyJointRadians(
          this.currentJointAngles,
          typeof performance !== 'undefined' ? performance.now() : Date.now()
        );
        this.syncSelectedJoint(this.selectedJointName);
        this.requestRender();
      }
    }
  }

  public syncSelectedJoint(jointName: string | null): void {
    this.selectedJointName = jointName;
    if (this.disposed) return;

    if (!jointName) {
      this.clearHighlight();
      this.requestRender();
      return;
    }

    if (this.activeUrdfRobot) {
      const mapping = UR5_JOINT_MAPPING.find((m) => m.storeJointName === jointName);
      const linkObj = mapping ? this.activeUrdfRobot.links[mapping.linkName] : undefined;
      if (linkObj) {
        this.applyHighlightOnRoot(linkObj);
        return;
      }
    }

    const mockNode = this.mockLinkRoots[jointName];
    if (mockNode) {
      this.applyHighlightOnRoot(mockNode);
    }
  }

  public syncSemanticObjects(objects: SceneObjectItem[], heldObjectId: string | null): void {
    this.latestSceneObjects = objects;
    this.latestHeldObjectId = heldObjectId;
    if (this.disposed) return;

    this.semanticGroup.visible = this.viewportSettings.showSemantics;

    if (this.semanticMeshMap.size === 0) {
      const sharedRingGeom = new THREE.RingGeometry(0.018, 0.026, 24);
      const sharedRingMat = new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      });

      for (const obj of objects) {
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

        this.semanticGroup.add(group);
        this.semanticMeshMap.set(obj.id, group);
      }

      sharedRingGeom.dispose();
      sharedRingMat.dispose();
    }

    for (const obj of objects) {
      const group = this.semanticMeshMap.get(obj.id);
      if (!group) continue;
      if (heldObjectId === obj.id && this.toolTargetNode) {
        this.toolTargetNode.getWorldPosition(this._toolWorldPos);
        group.position.set(
          this._toolWorldPos.x,
          Math.max(0.04, this._toolWorldPos.y - 0.035),
          this._toolWorldPos.z
        );
      } else {
        group.position.set(obj.position[0], obj.position[1], obj.position[2]);
      }
    }
    this.requestRender();
  }

  public updateTrajectoryOverlay(
    waypoints: TeachWaypoint[],
    plannedTrajectory: TrajectoryPoint[],
    trajectoryMode: TrajectoryMode,
    playbackState: 'IDLE' | 'PLAYING' | 'PAUSED',
    playbackIndex: number
  ): void {
    if (this.disposed) return;

    while (this.trajectoryGroup.children.length > 0) {
      const child = this.trajectoryGroup.children[0];
      this.trajectoryGroup.remove(child);
      this.disposeObjectTree(child, true);
    }

    if (waypoints.length > 0 && this.sharedWaypointGeom && this.sharedWaypointMat) {
      for (const wp of waypoints) {
        const marker = new THREE.Mesh(this.sharedWaypointGeom, this.sharedWaypointMat);
        marker.position.set(wp.threePosition[0], wp.threePosition[1], wp.threePosition[2]);
        this.trajectoryGroup.add(marker);
      }
    }

    if (plannedTrajectory.length >= 2) {
      const linePoints = plannedTrajectory.map(
        (pt) => new THREE.Vector3(pt.threePosition[0], pt.threePosition[1], pt.threePosition[2])
      );
      const lineGeom = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lineColor = trajectoryMode === 'CARTESIAN_LINEAR' ? 0x34d399 : 0x38bdf8;
      const lineMat = new THREE.LineBasicMaterial({ color: lineColor });
      this.trajectoryGroup.add(new THREE.Line(lineGeom, lineMat));

      if (
        (playbackState !== 'IDLE' || playbackIndex > 0) &&
        this.sharedCursorGeom &&
        this.sharedCursorMat
      ) {
        const activePt = plannedTrajectory[playbackIndex];
        if (activePt) {
          const cursorMesh = new THREE.Mesh(this.sharedCursorGeom, this.sharedCursorMat);
          cursorMesh.position.set(
            activePt.threePosition[0],
            activePt.threePosition[1],
            activePt.threePosition[2]
          );
          this.trajectoryGroup.add(cursorMesh);
        }
      }
    }
    this.requestRender();
  }

  public updateActionPreviewOverlay(
    previewTrajectory: TrajectoryPoint[],
    actionExecutionStatus: ActionExecutionStatus,
    actionFrameIndex: number
  ): void {
    if (this.disposed) return;

    while (this.actionPreviewGroup.children.length > 0) {
      const child = this.actionPreviewGroup.children[0];
      this.actionPreviewGroup.remove(child);
      this.disposeObjectTree(child, true);
    }

    if (
      previewTrajectory.length >= 2 &&
      (actionExecutionStatus === 'PREVIEW' || actionExecutionStatus === 'EXECUTING')
    ) {
      const pts = previewTrajectory.map(
        (pt) => new THREE.Vector3(pt.threePosition[0], pt.threePosition[1], pt.threePosition[2])
      );
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: actionExecutionStatus === 'PREVIEW' ? 0xfbbf24 : 0x34d399,
      });
      this.actionPreviewGroup.add(new THREE.Line(geom, mat));

      const endPt = pts[pts.length - 1];
      if (this.sharedWaypointGeom && this.sharedWaypointMat) {
        const targetDot = new THREE.Mesh(this.sharedWaypointGeom, this.sharedWaypointMat);
        targetDot.position.copy(endPt);
        this.actionPreviewGroup.add(targetDot);
      }

      if (
        actionExecutionStatus === 'EXECUTING' &&
        this.sharedCursorGeom &&
        this.sharedCursorMat
      ) {
        const curPt = pts[Math.min(actionFrameIndex, pts.length - 1)];
        const execDot = new THREE.Mesh(this.sharedCursorGeom, this.sharedCursorMat);
        execDot.position.copy(curPt);
        this.actionPreviewGroup.add(execDot);
      }
    }
    this.requestRender();
  }

  private ensureWorkspaceCloud(joints: JointState[]): void {
    if (!this.viewportSettings.showWorkspace) {
      if (this.workspaceInstancedMesh) this.workspaceInstancedMesh.visible = false;
      return;
    }

    if (!this.workspaceInstancedMesh) {
      const limits = joints.map((j) => ({ min: j.min, max: j.max }));
      const data = generateWorkspacePointCloud(limits, 2400);
      this.callbacks.onWorkspaceStats?.(data.count, data.maxReachMeters);

      const geom = new THREE.IcosahedronGeometry(0.0085, 0);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      });

      const instMesh = new THREE.InstancedMesh(geom, mat, data.count);
      instMesh.name = 'workspace-instanced-cloud';

      for (let i = 0; i < data.count; i++) {
        const idx = i * 3;
        this._dummyMatrix.makeTranslation(
          data.positions[idx],
          data.positions[idx + 1],
          data.positions[idx + 2]
        );
        instMesh.setMatrixAt(i, this._dummyMatrix);
        this._tempColor.setRGB(data.colors[idx], data.colors[idx + 1], data.colors[idx + 2]);
        instMesh.setColorAt(i, this._tempColor);
      }
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      instMesh.computeBoundingSphere();

      this.workspaceInstancedMesh = instMesh;
      this.scene.add(this.workspaceInstancedMesh);
    }

    this.workspaceInstancedMesh.visible = true;
  }

  private updateSemanticScreenLabels(): void {
    if (!this.viewportSettings.showSemantics) {
      if (this.lastSemanticSnapshotKey !== 'HIDDEN') {
        this.lastSemanticSnapshotKey = 'HIDDEN';
        this.callbacks.onSemanticLabelsUpdate?.([]);
      }
      return;
    }

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const nextLabels: SemanticLabelCoord[] = [];
    let snapshotKey = '';
    for (const obj of this.latestSceneObjects) {
      const group = this.semanticMeshMap.get(obj.id);
      if (!group) continue;
      this._projVec.copy(group.position);
      this._projVec.y += obj.graspOffset[1] + 0.05;
      this._projVec.project(this.camera);

      const visible = this._projVec.z >= -1 && this._projVec.z <= 1;
      const x = ((this._projVec.x + 1) / 2) * width;
      const y = ((-this._projVec.y + 1) / 2) * height;
      const isHeld = this.latestHeldObjectId === obj.id;
      snapshotKey += `${obj.id}:${x.toFixed(1)},${y.toFixed(1)},${visible ? 1 : 0},${isHeld ? 1 : 0}|`;
      nextLabels.push({
        id: obj.id,
        label: obj.label,
        x,
        y,
        visible,
        isHeld,
      });
    }

    if (snapshotKey !== this.lastSemanticSnapshotKey) {
      this.lastSemanticSnapshotKey = snapshotKey;
      this.callbacks.onSemanticLabelsUpdate?.(nextLabels);
    }
  }

  private handlePointerDown(event: PointerEvent): void {
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.disposed) return;
    const dx = event.clientX - this.pointerDownPos.x;
    const dy = event.clientY - this.pointerDownPos.y;
    if (Math.hypot(dx, dy) > 5) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.robotContainer.children, true);

    if (hits.length === 0) {
      this.callbacks.onJointPicked?.(null, null);
      this.clearHighlight();
      this.requestRender();
      return;
    }

    const hitMesh = hits[0].object;
    const match = this.activeUrdfRobot
      ? resolvePickedUrdfObject(hitMesh)
      : resolvePickedMockObject(hitMesh);

    if (match) {
      this.callbacks.onJointPicked?.(match.storeJointName, match.linkName);
      this.applyHighlightOnRoot(match.highlightRoot);
    } else {
      this.callbacks.onJointPicked?.(null, null);
      this.clearHighlight();
      this.requestRender();
    }
  }

  private attachToolAxes(target: THREE.Object3D | null): void {
    if (!target) return;
    this.toolTargetNode = target;
    this.toolAxesHelper = new THREE.AxesHelper(0.14);
    this.toolAxesHelper.visible = this.viewportSettings.showToolAxes;
    target.add(this.toolAxesHelper);
  }

  private clearRobotContainer(): void {
    this.clearHighlight();
    if (this.toolAxesHelper) {
      this.toolAxesHelper.parent?.remove(this.toolAxesHelper);
      this.toolAxesHelper.dispose();
      this.toolAxesHelper = null;
    }
    this.toolTargetNode = null;
    this.activeUrdfRobot = null;
    Object.keys(this.mockJointNodes).forEach((k) => delete this.mockJointNodes[k]);
    Object.keys(this.mockLinkRoots).forEach((k) => delete this.mockLinkRoots[k]);

    while (this.robotContainer.children.length > 0) {
      const child = this.robotContainer.children[0];
      this.robotContainer.remove(child);
      this.disposeObjectTree(child);
    }
  }

  private clearHighlight(): void {
    for (const record of this.highlightedMeshes) {
      record.mesh.material = record.originalMaterial;
      if (Array.isArray(record.clonedMaterial)) {
        record.clonedMaterial.forEach((m) => this.disposeMaterialWithTextures(m));
      } else {
        this.disposeMaterialWithTextures(record.clonedMaterial);
      }
    }
    this.highlightedMeshes = [];
  }

  private createHighlightedMaterial(mat: THREE.Material): THREE.Material {
    const cloned = mat.clone();
    if ('emissive' in cloned && cloned.emissive instanceof THREE.Color) {
      cloned.emissive.setHex(0x38bdf8);
      if ('emissiveIntensity' in cloned) {
        (cloned as THREE.MeshStandardMaterial).emissiveIntensity = 0.5;
      }
    }
    return cloned;
  }

  private collectOwnLinkMeshes(root: THREE.Object3D, out: THREE.Mesh[]): void {
    for (const child of root.children) {
      const isChildUrdfJoint = Boolean((child as { isURDFJoint?: boolean }).isURDFJoint);
      const isChildMockJoint = Boolean(child.userData?.storeJointName);
      if (isChildUrdfJoint || isChildMockJoint) {
        continue;
      }
      if ((child as THREE.Mesh).isMesh) {
        out.push(child as THREE.Mesh);
      }
      this.collectOwnLinkMeshes(child, out);
    }
  }

  private applyHighlightOnRoot(root: THREE.Object3D | null): void {
    this.clearHighlight();
    if (!root) {
      this.requestRender();
      return;
    }

    const meshes: THREE.Mesh[] = [];
    if ((root as THREE.Mesh).isMesh) {
      meshes.push(root as THREE.Mesh);
    }
    this.collectOwnLinkMeshes(root, meshes);

    for (const mesh of meshes) {
      const originalMaterial = mesh.material;
      const clonedMaterial = Array.isArray(originalMaterial)
        ? originalMaterial.map((m) => this.createHighlightedMaterial(m))
        : this.createHighlightedMaterial(originalMaterial);

      mesh.material = clonedMaterial;
      this.highlightedMeshes.push({ mesh, originalMaterial, clonedMaterial });
    }
    this.requestRender();
  }

  private buildFallbackMockRobot(): void {
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.65,
      roughness: 0.35,
    });
    const linkMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.45,
      roughness: 0.4,
    });
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x0ea5e9,
      metalness: 0.7,
      roughness: 0.25,
    });

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
    this.mockJointNodes['joint_1'] = j1;
    this.mockLinkRoots['joint_1'] = j1;

    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 24), jointMat);
    shoulder.position.y = 0.06;
    shoulder.castShadow = true;
    j1.add(shoulder);

    const j2 = new THREE.Group();
    j2.position.set(0, 0.12, 0);
    j2.userData = { storeJointName: 'joint_2', linkName: 'upper_arm_link', axis: 'z' };
    j1.add(j2);
    this.mockJointNodes['joint_2'] = j2;
    this.mockLinkRoots['joint_2'] = j2;

    const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.42, 0.075), linkMat);
    upperArm.position.y = 0.21;
    upperArm.castShadow = true;
    j2.add(upperArm);

    const j3 = new THREE.Group();
    j3.position.set(0, 0.42, 0);
    j3.userData = { storeJointName: 'joint_3', linkName: 'forearm_link', axis: 'z' };
    j2.add(j3);
    this.mockJointNodes['joint_3'] = j3;
    this.mockLinkRoots['joint_3'] = j3;

    const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.06), linkMat);
    foreArm.position.y = 0.18;
    foreArm.castShadow = true;
    j3.add(foreArm);

    const j4 = new THREE.Group();
    j4.position.set(0, 0.36, 0);
    j4.userData = { storeJointName: 'joint_4', linkName: 'wrist_1_link', axis: 'z' };
    j3.add(j4);
    this.mockJointNodes['joint_4'] = j4;
    this.mockLinkRoots['joint_4'] = j4;

    const wrist1 = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.09, 18), jointMat);
    wrist1.position.y = 0.045;
    wrist1.castShadow = true;
    j4.add(wrist1);

    const j5 = new THREE.Group();
    j5.position.set(0, 0.09, 0);
    j5.userData = { storeJointName: 'joint_5', linkName: 'wrist_2_link', axis: 'y' };
    j4.add(j5);
    this.mockJointNodes['joint_5'] = j5;
    this.mockLinkRoots['joint_5'] = j5;

    const wrist2 = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.08, 18), baseMat);
    wrist2.position.y = 0.04;
    wrist2.castShadow = true;
    j5.add(wrist2);

    const j6 = new THREE.Group();
    j6.position.set(0, 0.08, 0);
    j6.userData = { storeJointName: 'joint_6', linkName: 'wrist_3_link', axis: 'z' };
    j5.add(j6);
    this.mockJointNodes['joint_6'] = j6;
    this.mockLinkRoots['joint_6'] = j6;

    const flange = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.035), jointMat);
    flange.position.y = 0.02;
    flange.castShadow = true;
    j6.add(flange);

    const mockTool = new THREE.Group();
    mockTool.position.set(0, 0.04, 0);
    j6.add(mockTool);
    this.attachToolAxes(mockTool);

    this.robotContainer.add(root);
  }

  private disposeMaterialWithTextures(mat: THREE.Material | undefined | null): void {
    if (!mat) return;
    const record = mat as unknown as Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) {
      const tex = record[slot];
      if (tex && typeof (tex as THREE.Texture).dispose === 'function') {
        (tex as THREE.Texture).dispose();
        record[slot] = null;
      }
    }
    mat.dispose();
  }

  private disposeObjectTree(root: THREE.Object3D, skipSharedResources = false): void {
    root.traverse((obj) => {
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        const inst = obj as THREE.InstancedMesh;
        inst.geometry?.dispose();
        if (Array.isArray(inst.material)) {
          inst.material.forEach((m) => this.disposeMaterialWithTextures(m));
        } else {
          this.disposeMaterialWithTextures(inst.material);
        }
        inst.dispose();
        return;
      }

      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (
          skipSharedResources &&
          (mesh.geometry === this.sharedWaypointGeom ||
            mesh.geometry === this.sharedCursorGeom)
        ) {
          return;
        }
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => this.disposeMaterialWithTextures(m));
        } else {
          this.disposeMaterialWithTextures(mesh.material);
        }
      } else if ((obj as THREE.Line).isLine) {
        const line = obj as THREE.Line;
        line.geometry?.dispose();
        if (Array.isArray(line.material)) {
          line.material.forEach((m) => this.disposeMaterialWithTextures(m));
        } else {
          this.disposeMaterialWithTextures(line.material);
        }
      } else if ((obj as THREE.Points).isPoints) {
        const pts = obj as THREE.Points;
        pts.geometry?.dispose();
        if (Array.isArray(pts.material)) {
          pts.material.forEach((m) => this.disposeMaterialWithTextures(m));
        } else {
          this.disposeMaterialWithTextures(pts.material);
        }
      } else if ((obj as THREE.Sprite).isSprite) {
        const sprite = obj as THREE.Sprite;
        sprite.geometry?.dispose();
        this.disposeMaterialWithTextures(sprite.material);
      }
    });
  }

  /**
   * 完整递归释放 Scene 中的 Geometry、Material、Texture、灯光阴影贴图及 WebGL 上下文，防止显存泄漏
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;

    window.removeEventListener('resize', this.boundHandleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.unsubscribeMotion?.();
    this.unsubscribeMotion = null;

    if (this.renderRafId !== 0) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = 0;
    }

    this.controls.removeEventListener('change', this.boundOnControlsChange);
    this.controls.removeEventListener('start', this.boundOnControlsStart);
    this.controls.dispose();

    this.renderer.domElement.removeEventListener('pointerdown', this.boundHandlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.boundHandlePointerUp);

    this.clearRobotContainer();
    this.disposeObjectTree(this.scene);

    this.semanticMeshMap.clear();
    this.workspaceInstancedMesh = null;

    this.sharedWaypointGeom?.dispose();
    this.sharedWaypointGeom = null;
    this.sharedWaypointMat?.dispose();
    this.sharedWaypointMat = null;
    this.sharedCursorGeom?.dispose();
    this.sharedCursorGeom = null;
    this.sharedCursorMat?.dispose();
    this.sharedCursorMat = null;

    this.gridHelper?.dispose();
    this.gridHelper = null;
    this.axesHelper.dispose();

    this.dirLight.shadow?.map?.dispose();
    this.hemiLight.dispose();
    this.dirLight.dispose();
    this.rimLight.dispose();

    this.scene.environment = null;
    this.scene.clear();

    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;
    this.pmremGenerator?.dispose();
    this.pmremGenerator = null;

    this.renderer.renderLists.dispose();
    this.renderer.dispose();

    // 显式触发底层 WebGL 上下文丢失以立即回收 GPU 显存
    const gl = this.renderer.getContext();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();

    this.renderer.domElement.remove();
  }
}
