import type { JointMappingEntry } from '../types/robot';

export const DEFAULT_URDF_MODEL_URL = '/models/ur5_6dof.urdf';
export const DEFAULT_URDF_MODEL_NAME = 'UR5-6DOF (URDF)';
export const FALLBACK_MOCK_MODEL_NAME = 'MOCK-6DOF-ARM (FALLBACK)';

/**
 * Store 逻辑关节名 <-> URDF 关节名 <-> 默认连杆的统一映射表
 * 保证控制台滑块、遥测协议与 URDF / Mock 模型通过同一套名称驱动。
 */
export const UR5_JOINT_MAPPING: JointMappingEntry[] = [
  {
    storeJointName: 'joint_1',
    urdfJointName: 'shoulder_pan_joint',
    linkName: 'shoulder_link',
    label: 'J1 肩部回转 (Pan)',
    defaultAngle: 0,
    min: -3.1416,
    max: 3.1416,
    defaultEffort: 1.2,
    defaultTemperature: 34.2,
  },
  {
    storeJointName: 'joint_2',
    urdfJointName: 'shoulder_lift_joint',
    linkName: 'upper_arm_link',
    label: 'J2 大臂俯仰 (Lift)',
    defaultAngle: -0.35,
    min: -2.3562,
    max: 2.3562,
    defaultEffort: 18.4,
    defaultTemperature: 38.5,
  },
  {
    storeJointName: 'joint_3',
    urdfJointName: 'elbow_joint',
    linkName: 'forearm_link',
    label: 'J3 肘部俯仰 (Elbow)',
    defaultAngle: 0.85,
    min: -2.618,
    max: 2.618,
    defaultEffort: 11.2,
    defaultTemperature: 36.8,
  },
  {
    storeJointName: 'joint_4',
    urdfJointName: 'wrist_1_joint',
    linkName: 'wrist_1_link',
    label: 'J4 腕部俯仰 (Wrist 1)',
    defaultAngle: -0.5,
    min: -3.1416,
    max: 3.1416,
    defaultEffort: 3.6,
    defaultTemperature: 35.1,
  },
  {
    storeJointName: 'joint_5',
    urdfJointName: 'wrist_2_joint',
    linkName: 'wrist_2_link',
    label: 'J5 腕部偏航 (Wrist 2)',
    defaultAngle: 0.45,
    min: -3.1416,
    max: 3.1416,
    defaultEffort: 2.1,
    defaultTemperature: 34.4,
  },
  {
    storeJointName: 'joint_6',
    urdfJointName: 'wrist_3_joint',
    linkName: 'wrist_3_link',
    label: 'J6 法兰旋转 (Wrist 3)',
    defaultAngle: 0,
    min: -3.1416,
    max: 3.1416,
    defaultEffort: 0.8,
    defaultTemperature: 33.6,
  },
];

export const STORE_TO_URDF_JOINT: Record<string, string> = Object.fromEntries(
  UR5_JOINT_MAPPING.map((entry) => [entry.storeJointName, entry.urdfJointName])
);

export const URDF_TO_STORE_JOINT: Record<string, string> = Object.fromEntries(
  UR5_JOINT_MAPPING.map((entry) => [entry.urdfJointName, entry.storeJointName])
);

export const LINK_TO_STORE_JOINT: Record<string, string> = Object.fromEntries(
  UR5_JOINT_MAPPING.map((entry) => [entry.linkName, entry.storeJointName])
);
