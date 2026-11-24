import * as THREE from 'three';
import type { EndEffectorPose, TeachWaypoint, TrajectoryPoint } from '../types/robot';

interface KinematicLinkSpec {
  xyz: [number, number, number];
  rpy?: [number, number, number];
  axis: 'x' | 'y' | 'z' | 'fixed';
}

/**
 * 与 public/models/ur5_6dof.urdf 严格对齐的串联运动学链定义
 */
const UR5_CHAIN: KinematicLinkSpec[] = [
  { xyz: [0, 0, 0.08], axis: 'z' }, // shoulder_pan_joint
  { xyz: [0, 0.115, 0.08], axis: 'y' }, // shoulder_lift_joint
  { xyz: [0, -0.095, 0.425], axis: 'y' }, // elbow_joint
  { xyz: [0, 0.088, 0.39], axis: 'y' }, // wrist_1_joint
  { xyz: [0, 0, 0.096], axis: 'z' }, // wrist_2_joint
  { xyz: [0, 0.072, 0.065], axis: 'y' }, // wrist_3_joint
  { xyz: [0, 0.091, 0], rpy: [-1.5708, 0, 0], axis: 'fixed' }, // tool0_fixed
];

const ROS_TO_THREE_MATRIX = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

const _stepMat = new THREE.Matrix4();
const _rotMat = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

function buildLocalTransform(spec: KinematicLinkSpec, angle: number): THREE.Matrix4 {
  _stepMat.makeTranslation(spec.xyz[0], spec.xyz[1], spec.xyz[2]);

  if (spec.rpy) {
    _euler.set(spec.rpy[0], spec.rpy[1], spec.rpy[2], 'ZYX');
    _rotMat.makeRotationFromEuler(_euler);
    _stepMat.multiply(_rotMat);
  }

  if (spec.axis === 'x') {
    _rotMat.makeRotationX(angle);
    _stepMat.multiply(_rotMat);
  } else if (spec.axis === 'y') {
    _rotMat.makeRotationY(angle);
    _stepMat.multiply(_rotMat);
  } else if (spec.axis === 'z') {
    _rotMat.makeRotationZ(angle);
    _stepMat.multiply(_rotMat);
  }

  return _stepMat;
}

/**
 * 正运动学求解（FK）：输入 6 个关节弧度 -> 输出 ROS 坐标系与 Three.js 世界坐标系下的末端位姿
 */
export function computeForwardKinematics(angles: number[]): EndEffectorPose {
  const rosMat = new THREE.Matrix4().identity();

  for (let i = 0; i < UR5_CHAIN.length; i++) {
    const spec = UR5_CHAIN[i];
    const q = spec.axis === 'fixed' ? 0 : (angles[i] ?? 0);
    const local = buildLocalTransform(spec, q);
    rosMat.multiply(local);
  }

  // 提取 ROS base_link 下位置与姿态
  rosMat.decompose(_pos, _quat, _scale);
  const rosPosition: [number, number, number] = [_pos.x, _pos.y, _pos.z];

  // 转换到 Three.js Y-up 世界坐标系
  const threeMat = new THREE.Matrix4().multiplyMatrices(ROS_TO_THREE_MATRIX, rosMat);
  threeMat.decompose(_pos, _quat, _scale);
  const threePosition: [number, number, number] = [_pos.x, _pos.y, _pos.z];

  const eulerDeg = new THREE.Euler().setFromQuaternion(_quat, 'XYZ');
  const radToDeg = 180 / Math.PI;
  const rpyDeg: [number, number, number] = [
    eulerDeg.x * radToDeg,
    eulerDeg.y * radToDeg,
    eulerDeg.z * radToDeg,
  ];

  return {
    rosPosition,
    threePosition,
    rpyDeg,
  };
}

/**
 * 求解 3x3 线性方程组 A * x = b（用于阻尼最小二乘 IK）
 */
function solve3x3(A: number[][], b: number[]): number[] {
  const m = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
        pivot = row;
      }
    }
    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }
    const diag = m[col][col];
    if (Math.abs(diag) < 1e-10) continue;

    for (let j = col; j < 4; j++) m[col][j] /= diag;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j < 4; j++) {
        m[row][j] -= factor * m[col][j];
      }
    }
  }

  return [m[0][3], m[1][3], m[2][3]];
}

/**
 * 数值逆运动学求解（Damped Least Squares Jacobian IK，仅约束末端 XYZ 位置）
 * 用于笛卡尔空间末端直线轨迹插补。
 */
export function solvePositionIK(
  targetThreePos: [number, number, number],
  seedAngles: number[],
  limits: Array<{ min: number; max: number }>,
  maxIterations = 35
): number[] {
  const q = seedAngles.slice(0, 6);
  const eps = 1e-4;
  const lambdaSq = 0.015 * 0.015;
  const jac: number[][] = [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ];

  for (let iter = 0; iter < maxIterations; iter++) {
    const curr = computeForwardKinematics(q).threePosition;
    const ex = targetThreePos[0] - curr[0];
    const ey = targetThreePos[1] - curr[1];
    const ez = targetThreePos[2] - curr[2];
    const errNorm = Math.hypot(ex, ey, ez);
    if (errNorm < 5e-4) break;

    for (let j = 0; j < 6; j++) {
      const orig = q[j];
      q[j] = orig + eps;
      const pert = computeForwardKinematics(q).threePosition;
      q[j] = orig;
      jac[0][j] = (pert[0] - curr[0]) / eps;
      jac[1][j] = (pert[1] - curr[1]) / eps;
      jac[2][j] = (pert[2] - curr[2]) / eps;
    }

    // J * J^T + lambda^2 * I (3x3)
    const jjt: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = r === c ? lambdaSq : 0;
        for (let k = 0; k < 6; k++) {
          sum += jac[r][k] * jac[c][k];
        }
        jjt[r][c] = sum;
      }
    }

    const y = solve3x3(jjt, [ex, ey, ez]);
    for (let j = 0; j < 6; j++) {
      const dq = jac[0][j] * y[0] + jac[1][j] * y[1] + jac[2][j] * y[2];
      const clampedStep = Math.max(-0.2, Math.min(0.2, dq));
      const lim = limits[j];
      const next = q[j] + clampedStep;
      q[j] = lim ? Math.min(Math.max(next, lim.min), lim.max) : next;
    }
  }

  return q;
}

/**
 * Halton 准随机序列采样工作空间可达点云
 */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

export interface WorkspacePointCloudData {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
  maxReachMeters: number;
}

export function generateWorkspacePointCloud(
  limits: Array<{ min: number; max: number }>,
  sampleCount = 2400
): WorkspacePointCloudData {
  const primes = [2, 3, 5, 7, 11, 13];
  const positions = new Float32Array(sampleCount * 3);
  const colors = new Float32Array(sampleCount * 3);
  let validCount = 0;
  let maxReach = 0;

  const q = new Array<number>(6).fill(0);
  for (let i = 1; i <= sampleCount * 2 && validCount < sampleCount; i++) {
    for (let j = 0; j < 6; j++) {
      const h = halton(i, primes[j]);
      const lim = limits[j];
      q[j] = lim.min + h * (lim.max - lim.min);
    }

    const pos = computeForwardKinematics(q).threePosition;
    // 过滤掉低于地面 (y < 0.02m) 的非物理地下点
    if (pos[1] < 0.02) continue;

    const idx = validCount * 3;
    positions[idx] = pos[0];
    positions[idx + 1] = pos[1];
    positions[idx + 2] = pos[2];

    const reach = Math.hypot(pos[0], pos[1], pos[2]);
    if (reach > maxReach) maxReach = reach;

    // 高度/半径渐变着色：低处偏青蓝 (#0ea5e9)，高处偏琥珀 (#f59e0b)
    const t = Math.min(1, Math.max(0, pos[1] / 1.15));
    colors[idx] = 0.08 + t * 0.88;
    colors[idx + 1] = 0.65 - t * 0.05;
    colors[idx + 2] = 0.95 - t * 0.85;

    validCount += 1;
  }

  return {
    positions: positions.subarray(0, validCount * 3),
    colors: colors.subarray(0, validCount * 3),
    count: validCount,
    maxReachMeters: maxReach,
  };
}

/**
 * 关节空间平滑轨迹规划（Minimum-Jerk / Smoothstep 曲线插值）
 */
export function planJointSpaceTrajectory(
  waypoints: TeachWaypoint[],
  stepsPerSegment = 24
): TrajectoryPoint[] {
  if (waypoints.length < 2) return [];
  const points: TrajectoryPoint[] = [];

  for (let seg = 0; seg < waypoints.length - 1; seg++) {
    const start = waypoints[seg].angles;
    const end = waypoints[seg + 1].angles;

    for (let s = 0; s <= stepsPerSegment; s++) {
      if (seg > 0 && s === 0) continue;
      const t = s / stepsPerSegment;
      // Smoothstep S 曲线，起止速度平缓
      const alpha = t * t * (3 - 2 * t);
      const angles = start.map((q0, idx) => q0 + (end[idx] - q0) * alpha);
      const fk = computeForwardKinematics(angles);
      points.push({
        angles,
        threePosition: fk.threePosition,
      });
    }
  }

  return points;
}

/**
 * 笛卡尔空间末端直线轨迹规划（线性插值末端位置 + 连续热启动 IK）
 */
export function planCartesianLinearTrajectory(
  waypoints: TeachWaypoint[],
  limits: Array<{ min: number; max: number }>,
  stepsPerSegment = 24
): TrajectoryPoint[] {
  if (waypoints.length < 2) return [];
  const points: TrajectoryPoint[] = [];

  let seedAngles = waypoints[0].angles.slice();
  const startFk = computeForwardKinematics(seedAngles);
  points.push({
    angles: seedAngles.slice(),
    threePosition: startFk.threePosition,
  });

  for (let seg = 0; seg < waypoints.length - 1; seg++) {
    const p0 = waypoints[seg].threePosition;
    const p1 = waypoints[seg + 1].threePosition;

    for (let s = 1; s <= stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      const target: [number, number, number] = [
        p0[0] + (p1[0] - p0[0]) * t,
        p0[1] + (p1[1] - p0[1]) * t,
        p0[2] + (p1[2] - p0[2]) * t,
      ];
      seedAngles = solvePositionIK(target, seedAngles, limits, 30);
      const fk = computeForwardKinematics(seedAngles);
      points.push({
        angles: seedAngles.slice(),
        threePosition: fk.threePosition,
      });
    }
  }

  return points;
}
