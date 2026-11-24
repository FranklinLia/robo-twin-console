export interface JointState {
  name: string;
  label: string;
  angle: number; // 弧度制 (rad)
  min: number;
  max: number;
}