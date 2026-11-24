import {
  computeForwardKinematics,
  solvePositionIK,
} from './kinematics';
import type {
  CompiledActionStep,
  RobotActionCommand,
  SceneObjectItem,
  TrajectoryPoint,
} from '../types/robot';

export interface ActionCompilationResult {
  valid: boolean;
  error?: string;
  trajectory: TrajectoryPoint[];
  steps: CompiledActionStep[];
}

const SUPPORTED_TYPES = new Set(['home', 'move_to', 'pick', 'place', 'wait']);
const SHOULDER_ORIGIN: [number, number, number] = [0, 0.16, 0];
const MAX_SAFE_REACH_M = 0.94;
const MIN_SAFE_HEIGHT_M = 0.04;
const MAX_IK_RESIDUAL_M = 0.035;

function getTargetPosition(
  action: RobotActionCommand,
  objects: SceneObjectItem[]
): { pos: [number, number, number]; obj?: SceneObjectItem } | null {
  if (action.targetId) {
    const obj = objects.find((o) => o.id === action.targetId);
    if (!obj) return null;
    return {
      pos: [
        obj.position[0] + obj.graspOffset[0],
        obj.position[1] + obj.graspOffset[1],
        obj.position[2] + obj.graspOffset[2],
      ],
      obj,
    };
  }
  if (action.position && action.position.length === 3) {
    return { pos: action.position };
  }
  return null;
}

/**
 * 校验结构化动作序列的物理安全边界并编译为可执行预览轨迹
 */
export function validateAndCompileActions(
  actions: RobotActionCommand[],
  currentAngles: number[],
  sceneObjects: SceneObjectItem[],
  limits: Array<{ min: number; max: number }>
): ActionCompilationResult {
  if (!actions || actions.length === 0) {
    return {
      valid: false,
      error: '动作序列为空，无可执行的动作步骤。',
      trajectory: [],
      steps: [],
    };
  }

  let workingAngles = currentAngles.slice(0, 6);
  const fullTrajectory: TrajectoryPoint[] = [
    {
      angles: workingAngles.slice(),
      threePosition: computeForwardKinematics(workingAngles).threePosition,
    },
  ];
  const steps: CompiledActionStep[] = [];
  let carryingObjectId: string | null = null;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!SUPPORTED_TYPES.has(action.type)) {
      return {
        valid: false,
        error: `安全拦截：不支持的动作原语 "${action.type}"。`,
        trajectory: [],
        steps: [],
      };
    }

    const startIndex = fullTrajectory.length - 1;
    let targetAngles: number[] = workingAngles.slice();
    let dropObjectId: string | null = null;
    let dropPosition: [number, number, number] | undefined;

    if (action.type === 'home') {
      targetAngles = [0, 0, 0, 0, 0, 0];
    } else if (action.type === 'wait') {
      targetAngles = workingAngles.slice();
    } else {
      const resolved = getTargetPosition(action, sceneObjects);
      if (!resolved) {
        return {
          valid: false,
          error: `安全拦截：步骤 ${i + 1} 引用了未知场景目标 "${action.targetId ?? 'unknown'}"。`,
          trajectory: [],
          steps: [],
        };
      }

      const [tx, ty, tz] = resolved.pos;
      if (ty < MIN_SAFE_HEIGHT_M) {
        return {
          valid: false,
          error: `安全拦截：目标高度 Y=${ty.toFixed(2)}m 低于安全桌面高度 (${MIN_SAFE_HEIGHT_M}m)，存在碰撞风险。`,
          trajectory: [],
          steps: [],
        };
      }

      const reach = Math.hypot(
        tx - SHOULDER_ORIGIN[0],
        ty - SHOULDER_ORIGIN[1],
        tz - SHOULDER_ORIGIN[2]
      );
      if (reach > MAX_SAFE_REACH_M) {
        return {
          valid: false,
          error: `安全拦截：目标距离肩部 ${reach.toFixed(2)}m 超出机械臂可达工作空间 (${MAX_SAFE_REACH_M}m)。`,
          trajectory: [],
          steps: [],
        };
      }

      // 如果是 move_to 接近物体，稍微抬高 0.08m 作为预备高度；pick/place 则直达作业点
      const goalPos: [number, number, number] =
        action.type === 'move_to' && resolved.obj
          ? [tx, ty + 0.08, tz]
          : [tx, ty, tz];

      const solved = solvePositionIK(goalPos, workingAngles, limits, 45);
      const achieved = computeForwardKinematics(solved).threePosition;
      const residual = Math.hypot(
        achieved[0] - goalPos[0],
        achieved[1] - goalPos[1],
        achieved[2] - goalPos[2]
      );

      if (residual > MAX_IK_RESIDUAL_M) {
        return {
          valid: false,
          error: `安全拦截：目标点 (${goalPos.map((v) => v.toFixed(2)).join(', ')}) 逆解残差过大 (${(residual * 1000).toFixed(1)}mm)，拒绝执行。`,
          trajectory: [],
          steps: [],
        };
      }

      targetAngles = solved;

      if (action.type === 'pick' && resolved.obj) {
        if (resolved.obj.kind !== 'graspable') {
          return {
            valid: false,
            error: `安全拦截：${resolved.obj.label} 属于料盘而非可抓取工件。`,
            trajectory: [],
            steps: [],
          };
        }
        carryingObjectId = resolved.obj.id;
      }

      if (action.type === 'place' && resolved.obj && carryingObjectId) {
        dropObjectId = carryingObjectId;
        dropPosition = [
          resolved.obj.position[0],
          resolved.obj.position[1] + 0.04,
          resolved.obj.position[2],
        ];
        carryingObjectId = null;
      }
    }

    const segSteps = action.type === 'wait' ? 6 : 20;
    for (let s = 1; s <= segSteps; s++) {
      const t = s / segSteps;
      const alpha = t * t * (3 - 2 * t);
      const interp = workingAngles.map((q0, idx) => q0 + (targetAngles[idx] - q0) * alpha);
      fullTrajectory.push({
        angles: interp,
        threePosition: computeForwardKinematics(interp).threePosition,
      });
    }

    workingAngles = targetAngles;
    steps.push({
      index: i,
      action,
      startIndex,
      endIndex: fullTrajectory.length - 1,
      carryObjectId: action.type === 'pick' ? carryingObjectId : null,
      dropObjectId,
      dropPosition,
    });
  }

  return {
    valid: true,
    trajectory: fullTrajectory,
    steps,
  };
}
