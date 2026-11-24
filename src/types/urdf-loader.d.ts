declare module 'urdf-loader' {
  import type { LoadingManager, Material, Object3D, Vector3 } from 'three';

  export type PackageResolver = (pkg: string) => string;

  export type MeshLoadFunc = (
    pathToModel: string,
    manager: LoadingManager,
    material: Material,
    onComplete: (obj: Object3D | null, err?: Error) => void
  ) => void;

  export interface URDFJointLimit {
    lower: number;
    upper: number;
    effort: number;
    velocity: number;
  }

  export class URDFBase extends Object3D {
    urdfNode: Element | null;
    urdfName: string;
  }

  export class URDFVisual extends URDFBase {
    isURDFVisual: boolean;
  }

  export class URDFCollider extends URDFBase {
    isURDFCollider: boolean;
  }

  export class URDFLink extends URDFBase {
    isURDFLink: boolean;
    inertial: {
      mass: number;
      origin: { xyz: number[]; rpy: number[] };
      inertia: {
        ixx: number;
        ixy: number;
        ixz: number;
        iyy: number;
        iyz: number;
        izz: number;
      };
    };
  }

  export class URDFJoint extends URDFBase {
    isURDFJoint: boolean;
    jointType: string;
    jointValue: number[];
    readonly angle: number;
    axis: Vector3;
    limit: URDFJointLimit;
    ignoreLimits: boolean;
    mimicJoints: URDFMimicJoint[];
    setJointValue(...values: Array<number | null>): boolean;
  }

  export class URDFMimicJoint extends URDFJoint {
    mimicJoint: string | null;
    offset: number;
    multiplier: number;
    updateFromMimickedJoint(...values: Array<number | null>): boolean;
  }

  export class URDFRobot extends URDFLink {
    isURDFRobot: boolean;
    urdfRobotNode: Element | null;
    robotName: string | null;
    links: Record<string, URDFLink>;
    joints: Record<string, URDFJoint>;
    colliders: Record<string, Object3D>;
    visual: Record<string, Object3D>;
    frames: Record<string, Object3D>;
    getFrame(name: string): Object3D | undefined;
    setJointValue(jointName: string, ...angle: Array<number | null>): boolean;
    setJointValues(values: Record<string, number | Array<number | null>>): boolean;
  }

  export default class URDFLoader {
    manager: LoadingManager;
    loadMeshCb: MeshLoadFunc;
    parseVisual: boolean;
    parseCollision: boolean;
    packages: string | Record<string, string> | PackageResolver;
    workingPath: string;
    fetchOptions: RequestInit;
    constructor(manager?: LoadingManager);
    loadAsync(urdf: string): Promise<URDFRobot>;
    load(
      urdf: string,
      onComplete: (robot: URDFRobot) => void,
      onProgress?: (event: ProgressEvent | null) => void,
      onError?: (error: Error) => void
    ): void;
    parse(content: string | Document | Element, workingPath?: string): URDFRobot;
  }
}
