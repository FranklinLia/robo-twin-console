import * as THREE from 'three';
import URDFLoader, { type URDFJoint, type URDFLink, type URDFRobot } from 'urdf-loader';
import type { JointState } from '../types/robot';
import {
  LINK_TO_STORE_JOINT,
  STORE_TO_URDF_JOINT,
  URDF_TO_STORE_JOINT,
} from '../config/jointMapping';

export interface LoadedUrdfBundle {
  robot: URDFRobot;
  rootGroup: THREE.Group;
}

export interface PickedObjectMatch {
  storeJointName: string;
  urdfJointName: string;
  linkName: string;
  highlightRoot: THREE.Object3D;
}

/**
 * 加载 URDF 模型并完成坐标系转换（URDF Z-up -> Three.js Y-up）
 */
export async function loadUrdfRobot(url: string): Promise<LoadedUrdfBundle> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((assetUrl) => {
    if (assetUrl.startsWith('package://')) {
      const stripped = assetUrl.replace(/^package:\/\/[^/]+\//, '/models/');
      return stripped;
    }
    return assetUrl;
  });

  const loader = new URDFLoader(manager);
  loader.packages = '/models';

  const robot = await loader.loadAsync(url);
  if (!robot || !robot.joints || Object.keys(robot.joints).length === 0) {
    throw new Error(`URDF 文件 "${url}" 未包含有效关节定义`);
  }

  // 配置阴影与基础材质增强
  robot.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // 坐标系适配：ROS/URDF 为 Z-up，Three.js 为 Y-up
  const rootGroup = new THREE.Group();
  rootGroup.name = 'urdf-root-z-up-adapter';
  rootGroup.rotation.x = -Math.PI / 2;
  rootGroup.add(robot);

  return { robot, rootGroup };
}

/**
 * 统一驱动入口：将 store 中的关节角通过映射表同步到 URDFRobot
 */
export function applyJointsToUrdf(robot: URDFRobot, joints: JointState[]): void {
  const values: Record<string, number> = {};
  for (const joint of joints) {
    const urdfName = STORE_TO_URDF_JOINT[joint.name] ?? joint.urdfName ?? joint.name;
    if (robot.joints[urdfName]) {
      values[urdfName] = joint.angle;
    }
  }
  robot.setJointValues(values);
}

/**
 * 根据射线击中的 Mesh 向上回溯所属 URDFLink 与 driving URDFJoint
 */
export function resolvePickedUrdfObject(hitObject: THREE.Object3D): PickedObjectMatch | null {
  let cursor: THREE.Object3D | null = hitObject;
  let foundLink: URDFLink | null = null;
  let foundJoint: URDFJoint | null = null;

  while (cursor) {
    if (!foundLink && (cursor as URDFLink).isURDFLink) {
      foundLink = cursor as URDFLink;
    }
    if ((cursor as URDFJoint).isURDFJoint) {
      const candidate = cursor as URDFJoint;
      if (candidate.jointType !== 'fixed') {
        foundJoint = candidate;
        break;
      }
    }
    cursor = cursor.parent;
  }

  if (foundJoint) {
    const urdfJointName = foundJoint.urdfName || foundJoint.name;
    const storeJointName = URDF_TO_STORE_JOINT[urdfJointName];
    if (!storeJointName) return null;

    return {
      storeJointName,
      urdfJointName,
      linkName: foundLink?.urdfName || foundLink?.name || urdfJointName,
      highlightRoot: foundLink ?? foundJoint,
    };
  }

  // 若点击的是 base_link（无父可动关节），则关联其描述信息但不强行映射可动关节
  if (foundLink) {
    const mappedStoreJoint = LINK_TO_STORE_JOINT[foundLink.urdfName];
    if (mappedStoreJoint) {
      return {
        storeJointName: mappedStoreJoint,
        urdfJointName: STORE_TO_URDF_JOINT[mappedStoreJoint] ?? mappedStoreJoint,
        linkName: foundLink.urdfName,
        highlightRoot: foundLink,
      };
    }
  }

  return null;
}

/**
 * 从 Mock Fallback 模型中解析被击中 Mesh 对应的关节信息
 */
export function resolvePickedMockObject(hitObject: THREE.Object3D): PickedObjectMatch | null {
  let cursor: THREE.Object3D | null = hitObject;
  while (cursor) {
    const jointName = cursor.userData?.storeJointName as string | undefined;
    const linkName = cursor.userData?.linkName as string | undefined;
    if (jointName) {
      return {
        storeJointName: jointName,
        urdfJointName: STORE_TO_URDF_JOINT[jointName] ?? jointName,
        linkName: linkName ?? jointName,
        highlightRoot: cursor,
      };
    }
    cursor = cursor.parent;
  }
  return null;
}
