export type JointAlarmLevel = 'none' | 'warning' | 'critical';

export interface JointAlarm {
  level: Exclude<JointAlarmLevel, 'none'>;
  code: string;
  message: string;
  timestamp: number;
}

export interface AlarmLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warning' | 'critical';
  code: string;
  jointName: string;
  message: string;
}

export interface JointState {
  name: string;
  urdfName: string;
  label: string;
  angle: number; // 弧度制 (rad)
  min: number;
  max: number;
  velocity: number; // 角速度 (rad/s)
  effort: number; // 力矩 (N·m)
  temperature: number; // 关节温度 (°C)
  alarm: JointAlarm | null;
}

export type ConnectionStatus = 'LOCAL_SIM' | 'CONNECTING' | 'ONLINE' | 'OFFLINE';

export type DataSourceMode = 'WS_STREAM' | 'LOCAL_SIM';

export type ServerMotionMode = 'WAVE_DEMO' | 'HOLD';

export type ModelSourceMode = 'URDF' | 'MOCK_FALLBACK';

export type ThemeMode = 'dark' | 'light';

export type CameraPreset = 'ISO' | 'FRONT' | 'SIDE' | 'TOP';

export interface ViewportSettings {
  showGrid: boolean;
  showAxes: boolean;
  showShadows: boolean;
  showToolAxes: boolean;
  showWorkspace: boolean;
  showSemantics: boolean;
}

export interface JointMappingEntry {
  storeJointName: string;
  urdfJointName: string;
  linkName: string;
  label: string;
  defaultAngle: number;
  min: number;
  max: number;
  defaultEffort: number;
  defaultTemperature: number;
}

export interface PickedJointInfo {
  storeJointName: string;
  urdfJointName: string;
  linkName: string;
  label: string;
  angle: number;
  min: number;
  max: number;
}

export interface JointTelemetrySample {
  name: string;
  angle: number;
  velocity?: number;
  effort?: number;
  temperature?: number;
  alarm?: JointAlarm | null;
}

export interface TelemetryFrame {
  timestamp: number;
  joints: JointTelemetrySample[];
  rateHz?: number;
  latencyMs?: number;
}

export interface RobotDataSource {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): void;
  sendJointTarget(name: string, angle: number): void;
  sendHomeCommand(): void;
  onFrame(listener: (frame: TelemetryFrame) => void): () => void;
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
}

export interface EndEffectorPose {
  rosPosition: [number, number, number];
  threePosition: [number, number, number];
  rpyDeg: [number, number, number];
}

export interface TeachWaypoint {
  id: string;
  name: string;
  angles: number[];
  threePosition: [number, number, number];
}

export type TrajectoryMode = 'JOINT' | 'CARTESIAN_LINEAR';

export interface TrajectoryPoint {
  angles: number[];
  threePosition: [number, number, number];
}

// 阶段 4：具身智能语义场景与动作协议
export interface SceneObjectItem {
  id: string;
  label: string;
  kind: 'graspable' | 'receptacle';
  geometry: 'box' | 'cylinder' | 'tray';
  color: string;
  defaultPosition: [number, number, number];
  position: [number, number, number];
  graspOffset: [number, number, number];
}

export type RobotActionType = 'home' | 'move_to' | 'pick' | 'place' | 'wait';

export interface RobotActionCommand {
  type: RobotActionType;
  targetId?: string;
  position?: [number, number, number];
  durationMs?: number;
  description: string;
}

export type IntentEngineMode = 'LOCAL_RULE' | 'GEMINI';

export interface AgentParseResult {
  recognized: boolean;
  safetyBlocked: boolean;
  reason: string;
  actions: RobotActionCommand[];
  engine: IntentEngineMode;
}

export interface CompiledActionStep {
  index: number;
  action: RobotActionCommand;
  startIndex: number;
  endIndex: number;
  carryObjectId?: string | null;
  dropObjectId?: string | null;
  dropPosition?: [number, number, number];
}

export type ActionExecutionStatus = 'IDLE' | 'PREVIEW' | 'EXECUTING' | 'COMPLETED' | 'REJECTED';

export interface ExecutionLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}