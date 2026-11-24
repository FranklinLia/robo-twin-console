import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  DEFAULT_URDF_MODEL_NAME,
  DEFAULT_URDF_MODEL_URL,
  UR5_JOINT_MAPPING,
} from '../config/jointMapping';
import { createInitialSceneObjects } from '../config/sceneObjects';
import { validateAndCompileActions } from '../services/actionPlanner';
import {
  computeForwardKinematics,
  planCartesianLinearTrajectory,
  planJointSpaceTrajectory,
} from '../services/kinematics';
import { parseIntentLocally } from '../services/localIntentParser';
import { LocalSimDataSource } from '../services/robotDataSource';
import { sharedTelemetryBuffer } from '../services/telemetryBuffer';
import { WsRobotDataSource } from '../services/wsRobotDataSource';
import type {
  ActionExecutionStatus,
  AgentParseResult,
  AlarmLogEntry,
  CameraPreset,
  CompiledActionStep,
  ConnectionStatus,
  DataSourceMode,
  EndEffectorPose,
  ExecutionLogEntry,
  IntentEngineMode,
  JointAlarm,
  JointAlarmLevel,
  JointState,
  ModelSourceMode,
  PickedJointInfo,
  RobotActionCommand,
  RobotDataSource,
  SceneObjectItem,
  ServerMotionMode,
  TeachWaypoint,
  TelemetryFrame,
  ThemeMode,
  TrajectoryMode,
  TrajectoryPoint,
  ViewportSettings,
} from '../types/robot';

const TEMP_WARN_THRESHOLD = 65;
const TEMP_CRIT_THRESHOLD = 80;
const LIMIT_MARGIN_RAD = 0.02;
const MAX_ALARM_LOGS = 80;
const MAX_EXEC_LOGS = 60;

const createInitialJoints = (): JointState[] =>
  UR5_JOINT_MAPPING.map((entry) => ({
    name: entry.storeJointName,
    urdfName: entry.urdfJointName,
    label: entry.label,
    angle: entry.defaultAngle,
    min: entry.min,
    max: entry.max,
    velocity: 0,
    effort: entry.defaultEffort,
    temperature: entry.defaultTemperature,
    alarm: null,
  }));

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const useRobotStore = defineStore('robot', () => {
  const joints = ref<JointState[]>(createInitialJoints());
  const connectionStatus = ref<ConnectionStatus>('LOCAL_SIM');
  const dataSourceMode = ref<DataSourceMode>('WS_STREAM');
  const motionMode = ref<ServerMotionMode>('WAVE_DEMO');
  const wsServerRunning = ref<boolean>(true);

  const modelName = ref<string>(DEFAULT_URDF_MODEL_NAME);
  const modelMode = ref<ModelSourceMode>('URDF');
  const modelLoadError = ref<string | null>(null);
  const urdfUrl = ref<string>(DEFAULT_URDF_MODEL_URL);
  const forceFallbackTest = ref<boolean>(false);

  const telemetryHz = ref<number>(0);
  const latencyMs = ref<number>(0);
  const lastFrameAt = ref<number | null>(null);

  const alarmLogs = ref<AlarmLogEntry[]>([]);
  const telemetryDockOpen = ref<boolean>(true);

  const selectedJointName = ref<string | null>(null);
  const selectedLinkName = ref<string | null>(null);

  const viewportSettings = ref<ViewportSettings>({
    showGrid: true,
    showAxes: true,
    showShadows: true,
    showToolAxes: true,
    showWorkspace: false,
    showSemantics: true,
  });
  const cameraResetVersion = ref<number>(0);
  const cameraPreset = ref<CameraPreset>('ISO');
  const theme = ref<ThemeMode>('dark');

  // 阶段 3：运动学、工作空间与示教轨迹状态
  const threeWorldToolPos = ref<[number, number, number] | null>(null);
  const workspacePointCount = ref<number>(0);
  const workspaceMaxReach = ref<number>(0);

  const waypoints = ref<TeachWaypoint[]>([]);
  const trajectoryMode = ref<TrajectoryMode>('JOINT');
  const playbackState = ref<'IDLE' | 'PLAYING' | 'PAUSED'>('IDLE');
  const playbackIndex = ref<number>(0);
  let playbackTimer: ReturnType<typeof setInterval> | null = null;
  let waypointSeq = 0;

  // 阶段 4：具身智能层状态
  const sceneObjects = ref<SceneObjectItem[]>(createInitialSceneObjects());
  const heldObjectId = ref<string | null>(null);
  const intentEngine = ref<IntentEngineMode>('LOCAL_RULE');
  const isParsingIntent = ref<boolean>(false);
  const parseResult = ref<AgentParseResult | null>(null);
  const safetyValidationError = ref<string | null>(null);
  const actionExecutionStatus = ref<ActionExecutionStatus>('IDLE');
  const previewTrajectory = ref<TrajectoryPoint[]>([]);
  const compiledActionSteps = ref<CompiledActionStep[]>([]);
  const actionFrameIndex = ref<number>(0);
  const currentActionStepIndex = ref<number>(-1);
  const executionLogs = ref<ExecutionLogEntry[]>([]);
  let actionTimer: ReturnType<typeof setInterval> | null = null;
  let execLogSeq = 0;

  // 数据源生命周期管理
  let activeSource: RobotDataSource | null = null;
  let unbindFrame: (() => void) | null = null;
  let unbindStatus: (() => void) | null = null;
  const wsSource = new WsRobotDataSource();
  const localSource = new LocalSimDataSource();

  const lastJointAlarmCodes = new Map<string, string>();
  let alarmSeq = 0;

  const pushAlarmLog = (
    level: AlarmLogEntry['level'],
    code: string,
    jointName: string,
    message: string,
    timestamp = Date.now()
  ) => {
    alarmSeq += 1;
    alarmLogs.value.unshift({
      id: `${timestamp}-${alarmSeq}`,
      timestamp,
      level,
      code,
      jointName,
      message,
    });
    if (alarmLogs.value.length > MAX_ALARM_LOGS) {
      alarmLogs.value.length = MAX_ALARM_LOGS;
    }
  };

  const pushExecutionLog = (level: ExecutionLogEntry['level'], message: string) => {
    execLogSeq += 1;
    executionLogs.value.unshift({
      id: `${Date.now()}-${execLogSeq}`,
      timestamp: Date.now(),
      level,
      message,
    });
    if (executionLogs.value.length > MAX_EXEC_LOGS) {
      executionLogs.value.length = MAX_EXEC_LOGS;
    }
  };

  // Selectors
  const jointMap = computed<Record<string, JointState>>(() => {
    const map: Record<string, JointState> = {};
    for (const joint of joints.value) {
      map[joint.name] = joint;
    }
    return map;
  });

  const getJointByName = (name: string) =>
    computed(() => jointMap.value[name] ?? null);

  const selectedJoint = computed<JointState | null>(() =>
    selectedJointName.value ? jointMap.value[selectedJointName.value] ?? null : null
  );

  const pickedJointInfo = computed<PickedJointInfo | null>(() => {
    const joint = selectedJoint.value;
    if (!joint) return null;
    const mapping = UR5_JOINT_MAPPING.find((m) => m.storeJointName === joint.name);
    return {
      storeJointName: joint.name,
      urdfJointName: joint.urdfName,
      linkName: selectedLinkName.value ?? mapping?.linkName ?? joint.name,
      label: joint.label,
      angle: joint.angle,
      min: joint.min,
      max: joint.max,
    };
  });

  const activeAlarms = computed(() =>
    joints.value
      .filter((joint) => joint.alarm !== null)
      .map((joint) => ({
        jointName: joint.name,
        jointLabel: joint.label,
        alarm: joint.alarm!,
      }))
  );

  const highestAlarmLevel = computed<JointAlarmLevel>(() => {
    if (activeAlarms.value.some((item) => item.alarm.level === 'critical')) {
      return 'critical';
    }
    if (activeAlarms.value.some((item) => item.alarm.level === 'warning')) {
      return 'warning';
    }
    return 'none';
  });

  const maxTemperature = computed<number>(() =>
    joints.value.reduce((max, joint) => Math.max(max, joint.temperature), 0)
  );

  const isHomePose = computed<boolean>(() =>
    joints.value.every((joint) => Math.abs(joint.angle) < 1e-4)
  );

  const endEffectorPose = computed<EndEffectorPose>(() =>
    computeForwardKinematics(joints.value.map((j) => j.angle))
  );

  const fkWorldErrorMm = computed<number | null>(() => {
    if (!threeWorldToolPos.value) return null;
    const [fx, fy, fz] = endEffectorPose.value.threePosition;
    const [wx, wy, wz] = threeWorldToolPos.value;
    return Math.hypot(fx - wx, fy - wy, fz - wz) * 1000;
  });

  const plannedTrajectory = computed<TrajectoryPoint[]>(() => {
    if (waypoints.value.length < 2) return [];
    const limits = joints.value.map((j) => ({ min: j.min, max: j.max }));
    if (trajectoryMode.value === 'CARTESIAN_LINEAR') {
      return planCartesianLinearTrajectory(waypoints.value, limits, 24);
    }
    return planJointSpaceTrajectory(waypoints.value, 24);
  });

  const actionProgressPct = computed<number>(() => {
    const total = previewTrajectory.value.length;
    if (total <= 1) return 0;
    return Math.round((actionFrameIndex.value / (total - 1)) * 100);
  });

  const currentActionLabel = computed<string>(() => {
    if (actionExecutionStatus.value !== 'EXECUTING') return '';
    const step = compiledActionSteps.value[currentActionStepIndex.value];
    if (!step) return '执行中...';
    return `[${step.index + 1}/${compiledActionSteps.value.length}] ${step.action.description}`;
  });

  const evaluateJointAlarm = (joint: JointState, now: number): JointAlarm | null => {
    if (joint.temperature >= TEMP_CRIT_THRESHOLD) {
      return {
        level: 'critical',
        code: 'TEMP_OVERHEAT',
        message: `${joint.name} 严重过温 (${joint.temperature.toFixed(1)}°C >= ${TEMP_CRIT_THRESHOLD}°C)`,
        timestamp: now,
      };
    }
    if (joint.temperature >= TEMP_WARN_THRESHOLD) {
      return {
        level: 'warning',
        code: 'TEMP_HIGH',
        message: `${joint.name} 温度偏高 (${joint.temperature.toFixed(1)}°C >= ${TEMP_WARN_THRESHOLD}°C)`,
        timestamp: now,
      };
    }
    if (
      joint.angle <= joint.min + LIMIT_MARGIN_RAD ||
      joint.angle >= joint.max - LIMIT_MARGIN_RAD
    ) {
      return {
        level: 'warning',
        code: 'LIMIT_NEAR',
        message: `${joint.name} 触发软限位 (${(joint.angle * (180 / Math.PI)).toFixed(1)}°)`,
        timestamp: now,
      };
    }
    return null;
  };

  const syncAlarmStateForJoint = (joint: JointState, now: number) => {
    const nextAlarm = evaluateJointAlarm(joint, now);
    const prevCode = lastJointAlarmCodes.get(joint.name) ?? 'NONE';
    const nextCode = nextAlarm ? nextAlarm.code : 'NONE';

    joint.alarm = nextAlarm;
    if (nextAlarm && nextCode !== prevCode) {
      pushAlarmLog(nextAlarm.level, nextAlarm.code, joint.name, nextAlarm.message, now);
    }
    lastJointAlarmCodes.set(joint.name, nextCode);
  };

  // Actions
  const setJointAngle = (name: string, angle: number) => {
    const target = joints.value.find((j) => j.name === name);
    if (!target) return;
    target.angle = clamp(angle, target.min, target.max);
    syncAlarmStateForJoint(target, Date.now());

    if (dataSourceMode.value === 'WS_STREAM') {
      motionMode.value = 'HOLD';
      wsSource.sendJointTarget(target.name, target.angle);
    } else {
      sharedTelemetryBuffer.push(
        Date.now(),
        joints.value.map((j) => j.angle)
      );
    }
  };

  const applyJointVector = (angles: number[]) => {
    const now = Date.now();
    for (let i = 0; i < joints.value.length; i++) {
      const joint = joints.value[i];
      const nextAngle = clamp(angles[i] ?? 0, joint.min, joint.max);
      joint.angle = nextAngle;
      syncAlarmStateForJoint(joint, now);

      if (dataSourceMode.value === 'WS_STREAM') {
        wsSource.sendJointTarget(joint.name, nextAngle);
      }
    }
    if (dataSourceMode.value === 'LOCAL_SIM') {
      sharedTelemetryBuffer.push(
        now,
        joints.value.map((j) => j.angle)
      );
    }
  };

  const resetPose = () => {
    stopTrajectory();
    stopActionExecution();
    for (const joint of joints.value) {
      joint.angle = 0;
      joint.velocity = 0;
      syncAlarmStateForJoint(joint, Date.now());
    }
    if (dataSourceMode.value === 'WS_STREAM') {
      motionMode.value = 'HOLD';
      wsSource.sendHomeCommand();
    } else {
      sharedTelemetryBuffer.push(
        Date.now(),
        joints.value.map((j) => j.angle)
      );
    }
  };

  const selectJoint = (name: string | null, linkName: string | null = null) => {
    selectedJointName.value = name;
    selectedLinkName.value = linkName;
  };

  const setConnectionStatus = (status: ConnectionStatus) => {
    const prev = connectionStatus.value;
    connectionStatus.value = status;
    if (prev !== status) {
      if (status === 'OFFLINE' && dataSourceMode.value === 'WS_STREAM') {
        telemetryHz.value = 0;
        latencyMs.value = 0;
        pushAlarmLog('critical', 'COMM_LOST', 'SYSTEM', 'WebSocket 通信中断，正在等待重连...');
      } else if (status === 'ONLINE' && (prev === 'OFFLINE' || prev === 'CONNECTING')) {
        pushAlarmLog('info', 'COMM_RECOVERED', 'SYSTEM', 'WebSocket 遥测流已建立 (ONLINE)');
      }
    }
  };

  const setModelStatus = (
    mode: ModelSourceMode,
    name: string,
    error: string | null = null
  ) => {
    modelMode.value = mode;
    modelName.value = name;
    modelLoadError.value = error;
  };

  const setForceFallbackTest = (enabled: boolean) => {
    forceFallbackTest.value = enabled;
    urdfUrl.value = enabled ? '/models/__missing_test__.urdf' : DEFAULT_URDF_MODEL_URL;
  };

  const toggleViewportSetting = (key: keyof ViewportSettings) => {
    viewportSettings.value[key] = !viewportSettings.value[key];
  };

  const triggerCameraReset = (preset: CameraPreset = 'ISO') => {
    cameraPreset.value = preset;
    cameraResetVersion.value += 1;
  };

  const applyThemeAttribute = (mode: ThemeMode) => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', mode);
    }
    try {
      localStorage.setItem('robo-twin-theme', mode);
    } catch {
      // ignore storage restrictions
    }
  };

  const initTheme = () => {
    let initial: ThemeMode = 'dark';
    try {
      const saved = localStorage.getItem('robo-twin-theme');
      if (saved === 'light' || saved === 'dark') initial = saved;
    } catch {
      // ignore
    }
    theme.value = initial;
    applyThemeAttribute(initial);
  };

  const toggleTheme = () => {
    const next: ThemeMode = theme.value === 'dark' ? 'light' : 'dark';
    theme.value = next;
    applyThemeAttribute(next);
  };

  const disposeStoreTimers = () => {
    clearPlaybackTimer();
    clearActionTimer();
    activeSource?.disconnect();
  };

  const toggleTelemetryDock = () => {
    telemetryDockOpen.value = !telemetryDockOpen.value;
  };

  const clearAlarmLogs = () => {
    alarmLogs.value = [];
  };

  const setThreeWorldToolPos = (pos: [number, number, number] | null) => {
    threeWorldToolPos.value = pos;
  };

  const setWorkspaceStats = (count: number, maxReach: number) => {
    workspacePointCount.value = count;
    workspaceMaxReach.value = maxReach;
  };

  // 示教点与轨迹控制
  const recordWaypoint = (customName?: string) => {
    waypointSeq += 1;
    const angles = joints.value.map((j) => Number(j.angle.toFixed(4)));
    const fk = computeForwardKinematics(angles);
    waypoints.value.push({
      id: `wp-${Date.now()}-${waypointSeq}`,
      name: customName ?? `P${waypoints.value.length + 1}`,
      angles,
      threePosition: fk.threePosition,
    });
  };

  const loadSampleWaypoints = () => {
    stopTrajectory();
    const presets: Array<{ name: string; angles: number[] }> = [
      { name: 'P1 (拾取预备)', angles: [-0.7, -0.45, 1.05, -0.6, 0.35, 0] },
      { name: 'P2 (过渡抬升)', angles: [0.0, -0.25, 0.55, -0.3, 0.45, 0.4] },
      { name: 'P3 (放置目标)', angles: [0.85, -0.5, 1.15, -0.65, 0.25, 0.9] },
    ];
    waypoints.value = presets.map((preset, idx) => {
      waypointSeq += 1;
      const fk = computeForwardKinematics(preset.angles);
      return {
        id: `wp-sample-${waypointSeq}-${idx}`,
        name: preset.name,
        angles: preset.angles,
        threePosition: fk.threePosition,
      };
    });
    playbackIndex.value = 0;
  };

  const removeWaypoint = (id: string) => {
    stopTrajectory();
    waypoints.value = waypoints.value.filter((w) => w.id !== id);
  };

  const clearWaypoints = () => {
    stopTrajectory();
    waypoints.value = [];
  };

  const jumpToWaypoint = (id: string) => {
    const wp = waypoints.value.find((w) => w.id === id);
    if (!wp) return;
    stopTrajectory();
    if (dataSourceMode.value === 'WS_STREAM') {
      setServerMotionMode('HOLD');
    }
    applyJointVector(wp.angles);
  };

  const setTrajectoryMode = (mode: TrajectoryMode) => {
    stopTrajectory();
    trajectoryMode.value = mode;
  };

  const clearPlaybackTimer = () => {
    if (playbackTimer) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
  };

  const playTrajectory = () => {
    const traj = plannedTrajectory.value;
    if (traj.length < 2) return;

    if (dataSourceMode.value === 'WS_STREAM' && motionMode.value === 'WAVE_DEMO') {
      setServerMotionMode('HOLD');
    }

    if (playbackIndex.value >= traj.length - 1) {
      playbackIndex.value = 0;
    }

    playbackState.value = 'PLAYING';
    applyJointVector(traj[playbackIndex.value].angles);

    clearPlaybackTimer();
    playbackTimer = setInterval(() => {
      const currentTraj = plannedTrajectory.value;
      if (currentTraj.length === 0) {
        stopTrajectory();
        return;
      }
      if (playbackIndex.value >= currentTraj.length - 1) {
        clearPlaybackTimer();
        playbackState.value = 'IDLE';
        return;
      }
      playbackIndex.value += 1;
      applyJointVector(currentTraj[playbackIndex.value].angles);
    }, 50);
  };

  const pauseTrajectory = () => {
    clearPlaybackTimer();
    if (playbackState.value === 'PLAYING') {
      playbackState.value = 'PAUSED';
    }
  };

  const stepTrajectory = () => {
    const traj = plannedTrajectory.value;
    if (traj.length < 2) return;
    pauseTrajectory();
    if (dataSourceMode.value === 'WS_STREAM' && motionMode.value === 'WAVE_DEMO') {
      setServerMotionMode('HOLD');
    }
    playbackIndex.value = (playbackIndex.value + 1) % traj.length;
    playbackState.value = 'PAUSED';
    applyJointVector(traj[playbackIndex.value].angles);
  };

  const stopTrajectory = () => {
    clearPlaybackTimer();
    playbackState.value = 'IDLE';
    playbackIndex.value = 0;
  };

  const seekTrajectory = (index: number) => {
    const traj = plannedTrajectory.value;
    if (traj.length === 0) return;
    pauseTrajectory();
    if (dataSourceMode.value === 'WS_STREAM' && motionMode.value === 'WAVE_DEMO') {
      setServerMotionMode('HOLD');
    }
    const clamped = Math.min(Math.max(index, 0), traj.length - 1);
    playbackIndex.value = clamped;
    applyJointVector(traj[clamped].angles);
  };

  // 阶段 4：具身智能解析、安全校验、预览与执行
  const clearActionTimer = () => {
    if (actionTimer) {
      clearInterval(actionTimer);
      actionTimer = null;
    }
  };

  const stopActionExecution = () => {
    clearActionTimer();
    if (actionExecutionStatus.value === 'EXECUTING') {
      actionExecutionStatus.value = 'IDLE';
      currentActionStepIndex.value = -1;
      actionFrameIndex.value = 0;
    }
  };

  const cancelActionPreview = () => {
    clearActionTimer();
    previewTrajectory.value = [];
    compiledActionSteps.value = [];
    actionFrameIndex.value = 0;
    currentActionStepIndex.value = -1;
    safetyValidationError.value = null;
    actionExecutionStatus.value = 'IDLE';
    pushExecutionLog('info', '已取消动作预览');
  };

  const resetSceneObjects = () => {
    heldObjectId.value = null;
    sceneObjects.value = createInitialSceneObjects();
    pushExecutionLog('info', '语义场景物体已复位到初始位置');
  };

  const parseNaturalCommand = async (rawPrompt: string) => {
    stopTrajectory();
    clearActionTimer();
    safetyValidationError.value = null;
    previewTrajectory.value = [];
    compiledActionSteps.value = [];
    actionFrameIndex.value = 0;
    currentActionStepIndex.value = -1;

    isParsingIntent.value = true;
    try {
      let parsed: AgentParseResult;
      if (intentEngine.value === 'GEMINI') {
        const res = await fetch('/api/agent/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: rawPrompt,
            sceneObjects: sceneObjects.value.map((o) => ({
              id: o.id,
              label: o.label,
              kind: o.kind,
              graspPoint: [
                o.position[0] + o.graspOffset[0],
                o.position[1] + o.graspOffset[1],
                o.position[2] + o.graspOffset[2],
              ],
            })),
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          recognized?: boolean;
          safetyBlocked?: boolean;
          reason?: string;
          actions?: RobotActionCommand[];
        };
        if (!res.ok) {
          throw new Error(data.error ?? `服务端解析失败 (${res.status})`);
        }
        parsed = {
          recognized: Boolean(data.recognized),
          safetyBlocked: Boolean(data.safetyBlocked),
          reason: String(data.reason ?? ''),
          actions: data.actions ?? [],
          engine: 'GEMINI',
        };
      } else {
        parsed = parseIntentLocally(rawPrompt, sceneObjects.value);
      }

      parseResult.value = parsed;

      if (parsed.safetyBlocked || !parsed.recognized) {
        actionExecutionStatus.value = 'REJECTED';
        safetyValidationError.value = parsed.reason;
        pushExecutionLog(parsed.safetyBlocked ? 'error' : 'warn', parsed.reason);
        return;
      }

      // 结构化动作校验 & 轨迹编译（生成预览路径）
      const limits = joints.value.map((j) => ({ min: j.min, max: j.max }));
      const currentAngles = joints.value.map((j) => j.angle);
      const compiled = validateAndCompileActions(
        parsed.actions,
        currentAngles,
        sceneObjects.value,
        limits
      );

      if (!compiled.valid) {
        actionExecutionStatus.value = 'REJECTED';
        safetyValidationError.value = compiled.error ?? '安全校验未通过';
        pushExecutionLog('error', safetyValidationError.value);
        return;
      }

      previewTrajectory.value = compiled.trajectory;
      compiledActionSteps.value = compiled.steps;
      actionExecutionStatus.value = 'PREVIEW';
      pushExecutionLog(
        'info',
        `生成 ${compiled.steps.length} 步动作预览（共 ${compiled.trajectory.length} 帧轨迹点），等待确认执行`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parseResult.value = null;
      actionExecutionStatus.value = 'REJECTED';
      safetyValidationError.value = msg;
      pushExecutionLog('error', msg);
    } finally {
      isParsingIntent.value = false;
    }
  };

  const confirmAndExecuteActions = () => {
    const traj = previewTrajectory.value;
    const steps = compiledActionSteps.value;
    if (traj.length < 2 || steps.length === 0) return;

    if (dataSourceMode.value === 'WS_STREAM' && motionMode.value === 'WAVE_DEMO') {
      setServerMotionMode('HOLD');
    }

    actionExecutionStatus.value = 'EXECUTING';
    actionFrameIndex.value = 0;
    currentActionStepIndex.value = 0;
    let lastLoggedStep = -1;

    clearActionTimer();
    actionTimer = setInterval(() => {
      const idx = actionFrameIndex.value;
      if (idx >= traj.length) {
        clearActionTimer();
        actionExecutionStatus.value = 'COMPLETED';
        currentActionStepIndex.value = -1;
        pushExecutionLog('success', '全部动作序列执行完成');
        return;
      }

      applyJointVector(traj[idx].angles);

      // 查找当前所属动作步骤并更新夹爪物体附着状态
      const stepIdx = steps.findIndex((s) => idx >= s.startIndex && idx <= s.endIndex);
      if (stepIdx !== -1) {
        currentActionStepIndex.value = stepIdx;
        if (stepIdx !== lastLoggedStep) {
          lastLoggedStep = stepIdx;
          const activeStep = steps[stepIdx];
          pushExecutionLog('info', `执行步骤 [${stepIdx + 1}/${steps.length}]：${activeStep.action.description}`);
        }
        const activeStep = steps[stepIdx];
        if (idx === activeStep.endIndex) {
          if (activeStep.carryObjectId) {
            heldObjectId.value = activeStep.carryObjectId;
          }
          if (activeStep.dropObjectId && activeStep.dropPosition) {
            const obj = sceneObjects.value.find((o) => o.id === activeStep.dropObjectId);
            if (obj) {
              obj.position = [...activeStep.dropPosition];
            }
            heldObjectId.value = null;
          }
        }
      }

      if (idx >= traj.length - 1) {
        clearActionTimer();
        actionExecutionStatus.value = 'COMPLETED';
        currentActionStepIndex.value = -1;
        pushExecutionLog('success', '全部动作序列执行完成');
        return;
      }

      actionFrameIndex.value += 1;
    }, 45);
  };

  const applyTelemetryFrame = (frame: TelemetryFrame) => {
    lastFrameAt.value = frame.timestamp;
    if (typeof frame.rateHz === 'number') {
      telemetryHz.value = frame.rateHz;
    }
    if (typeof frame.latencyMs === 'number') {
      latencyMs.value = frame.latencyMs;
    }

    for (const sample of frame.joints) {
      const target = joints.value.find(
        (j) => j.name === sample.name || j.urdfName === sample.name
      );
      if (!target) continue;
      target.angle = clamp(sample.angle, target.min, target.max);
      if (typeof sample.velocity === 'number') {
        target.velocity = sample.velocity;
      }
      if (typeof sample.effort === 'number') {
        target.effort = sample.effort;
      }
      if (typeof sample.temperature === 'number') {
        target.temperature = sample.temperature;
      }
      if (sample.alarm !== undefined && sample.alarm !== null) {
        target.alarm = sample.alarm;
      } else {
        syncAlarmStateForJoint(target, frame.timestamp);
      }
    }

    sharedTelemetryBuffer.push(
      frame.timestamp,
      joints.value.map((j) => j.angle)
    );
  };

  const switchDataSource = async (mode: DataSourceMode) => {
    unbindFrame?.();
    unbindStatus?.();
    activeSource?.disconnect();

    dataSourceMode.value = mode;
    if (mode === 'WS_STREAM') {
      activeSource = wsSource;
    } else {
      activeSource = localSource;
      telemetryHz.value = 0;
      latencyMs.value = 0;
    }

    unbindFrame = activeSource.onFrame(applyTelemetryFrame);
    unbindStatus = activeSource.onStatusChange(setConnectionStatus);
    await activeSource.connect();
  };

  const setServerMotionMode = (mode: ServerMotionMode) => {
    motionMode.value = mode;
    if (dataSourceMode.value === 'WS_STREAM') {
      wsSource.setMotionMode(mode);
    }
  };

  const injectOverTemp = (jointName = 'joint_2', temperature = 86.5) => {
    if (dataSourceMode.value === 'WS_STREAM') {
      wsSource.injectTemperature(jointName, temperature);
    } else {
      const target = joints.value.find((j) => j.name === jointName);
      if (target) {
        target.temperature = temperature;
        syncAlarmStateForJoint(target, Date.now());
      }
    }
  };

  const clearFaults = () => {
    if (dataSourceMode.value === 'WS_STREAM') {
      wsSource.clearFaults();
    } else {
      for (const joint of joints.value) {
        const defaultEntry = UR5_JOINT_MAPPING.find((m) => m.storeJointName === joint.name);
        joint.temperature = defaultEntry?.defaultTemperature ?? 35.0;
        syncAlarmStateForJoint(joint, Date.now());
      }
    }
  };

  const syncServerStatus = async () => {
    try {
      const res = await fetch('/api/sim/status');
      if (res.ok) {
        const data = (await res.json()) as { wsRunning: boolean; motionMode: ServerMotionMode };
        wsServerRunning.value = data.wsRunning;
        motionMode.value = data.motionMode;
      }
    } catch {
      // ignore if offline
    }
  };

  const toggleMockWsServer = async () => {
    const endpoint = wsServerRunning.value ? '/api/sim/stop' : '/api/sim/start';
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { wsRunning: boolean };
        wsServerRunning.value = data.wsRunning;
      }
    } catch {
      // ignore
    }
  };

  return {
    // state
    joints,
    connectionStatus,
    dataSourceMode,
    motionMode,
    wsServerRunning,
    modelName,
    modelMode,
    modelLoadError,
    urdfUrl,
    forceFallbackTest,
    telemetryHz,
    latencyMs,
    lastFrameAt,
    alarmLogs,
    telemetryDockOpen,
    selectedJointName,
    selectedLinkName,
    viewportSettings,
    cameraResetVersion,
    cameraPreset,
    theme,
    threeWorldToolPos,
    workspacePointCount,
    workspaceMaxReach,
    waypoints,
    trajectoryMode,
    playbackState,
    playbackIndex,
    sceneObjects,
    heldObjectId,
    intentEngine,
    isParsingIntent,
    parseResult,
    safetyValidationError,
    actionExecutionStatus,
    previewTrajectory,
    compiledActionSteps,
    actionFrameIndex,
    currentActionStepIndex,
    executionLogs,
    // selectors
    jointMap,
    getJointByName,
    selectedJoint,
    pickedJointInfo,
    activeAlarms,
    highestAlarmLevel,
    maxTemperature,
    isHomePose,
    endEffectorPose,
    fkWorldErrorMm,
    plannedTrajectory,
    actionProgressPct,
    currentActionLabel,
    // actions
    setJointAngle,
    applyJointVector,
    resetPose,
    selectJoint,
    setConnectionStatus,
    setModelStatus,
    setForceFallbackTest,
    toggleViewportSetting,
    triggerCameraReset,
    initTheme,
    toggleTheme,
    disposeStoreTimers,
    toggleTelemetryDock,
    clearAlarmLogs,
    setThreeWorldToolPos,
    setWorkspaceStats,
    recordWaypoint,
    loadSampleWaypoints,
    removeWaypoint,
    clearWaypoints,
    jumpToWaypoint,
    setTrajectoryMode,
    playTrajectory,
    pauseTrajectory,
    stepTrajectory,
    stopTrajectory,
    seekTrajectory,
    parseNaturalCommand,
    confirmAndExecuteActions,
    cancelActionPreview,
    stopActionExecution,
    resetSceneObjects,
    applyTelemetryFrame,
    switchDataSource,
    setServerMotionMode,
    injectOverTemp,
    clearFaults,
    syncServerStatus,
    toggleMockWsServer,
  };
});
