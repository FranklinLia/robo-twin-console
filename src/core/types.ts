import type {
  ActionExecutionStatus,
  JointState,
  ModelSourceMode,
  SceneObjectItem,
  TeachWaypoint,
  ThemeMode,
  TrajectoryMode,
  TrajectoryPoint,
  ViewportSettings,
} from '../types/robot';
import type { MotionBuffer } from './MotionBuffer';

export interface SemanticLabelCoord {
  id: string;
  label: string;
  x: number;
  y: number;
  visible: boolean;
  isHeld: boolean;
}

export interface RobotEngineCallbacks {
  onModelLoadingChange?: (loading: boolean) => void;
  onModelStatusChange?: (
    mode: ModelSourceMode,
    modelName: string,
    error: string | null
  ) => void;
  onJointPicked?: (storeJointName: string | null, linkName: string | null) => void;
  onToolWorldPosition?: (pos: [number, number, number] | null) => void;
  onWorkspaceStats?: (count: number, maxReachMeters: number) => void;
  onSemanticLabelsUpdate?: (labels: SemanticLabelCoord[]) => void;
}

export interface RobotEngineInitOptions {
  container: HTMLElement;
  motionBuffer: MotionBuffer;
  theme: ThemeMode;
  viewportSettings: ViewportSettings;
  joints: JointState[];
  initialAngles: ArrayLike<number>;
  sceneObjects: SceneObjectItem[];
  heldObjectId: string | null;
  urdfUrl: string;
  selectedJointName: string | null;
  waypoints: TeachWaypoint[];
  plannedTrajectory: TrajectoryPoint[];
  trajectoryMode: TrajectoryMode;
  playbackState: 'IDLE' | 'PLAYING' | 'PAUSED';
  playbackIndex: number;
  previewTrajectory: TrajectoryPoint[];
  actionExecutionStatus: ActionExecutionStatus;
  actionFrameIndex: number;
  callbacks?: RobotEngineCallbacks;
}
