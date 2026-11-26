import { UR5_JOINT_MAPPING } from '../config/jointMapping';
import type {
  ConnectionStatus,
  JointTelemetrySample,
  RobotDataSource,
  TelemetryFrame,
} from '../types/robot';

const WAVE_AMPLITUDES = [0.85, 0.42, 0.52, 0.65, 0.72, 1.35];
const WAVE_FREQUENCIES = [0.65, 0.85, 0.95, 1.15, 1.25, 1.45];
const WAVE_PHASES = [0.0, 0.7, 1.4, 2.1, 0.4, 1.1];

/**
 * 本地仿真数据源：
 * - 支持手动滑块即时驱动（LOCAL_SIM）
 * - 支持 100Hz 本地高频模拟数据推送（零高频对象分配，用于压测 Float64Array + MotionBuffer + 10Hz UI 节流链路）
 */
export class LocalSimDataSource implements RobotDataSource {
  readonly id = 'local-sim';
  private frameListeners = new Set<(frame: TelemetryFrame) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  private stressTimer: ReturnType<typeof setTimeout> | null = null;
  private stressRunning = false;
  private targetRateHz = 100;
  private elapsedSec = 0;
  private nextTickAt = 0;
  private totalFrames = 0;
  private readonly frameTimestamps: number[] = [];

  // 预分配复用帧对象与关节样本数组，避免 100Hz 推送产生高频 GC
  private readonly jointAngles = new Float64Array(UR5_JOINT_MAPPING.length);
  private readonly reusableSamples: JointTelemetrySample[] = UR5_JOINT_MAPPING.map((m) => ({
    name: m.storeJointName,
    angle: m.defaultAngle,
    velocity: 0,
    effort: m.defaultEffort,
    temperature: m.defaultTemperature,
  }));
  private readonly reusableFrame: TelemetryFrame = {
    timestamp: 0,
    joints: this.reusableSamples,
    rateHz: 0,
    latencyMs: 0,
  };

  async connect(): Promise<void> {
    this.emitStatus('LOCAL_SIM');
  }

  disconnect(): void {
    this.stopHighFreqPush();
    this.emitStatus('OFFLINE');
  }

  sendJointTarget(_name: string, _angle: number): void {
    // 本地模式由 store 直接写入 Float64Array 与 MotionBuffer
  }

  sendHomeCommand(): void {
    // 本地模式由 store 直接归零
  }

  public isHighFreqRunning(): boolean {
    return this.stressRunning;
  }

  public getTotalFrames(): number {
    return this.totalFrames;
  }

  public startHighFreqPush(rateHz = 100): void {
    this.targetRateHz = Math.max(10, Math.min(200, rateHz));
    if (this.stressRunning) return;

    this.stressRunning = true;
    this.frameTimestamps.length = 0;
    this.totalFrames = 0;
    this.nextTickAt = performance.now();
    this.emitStatus('LOCAL_SIM');

    const intervalMs = 1000 / this.targetRateHz;
    const dt = 1 / this.targetRateHz;

    const tick = () => {
      if (!this.stressRunning) return;

      const nowPerf = performance.now();
      let steps = 0;
      while (this.nextTickAt <= nowPerf && steps < 3) {
        this.stepAndEmit(dt);
        this.nextTickAt += intervalMs;
        steps += 1;
      }

      if (this.nextTickAt < nowPerf - intervalMs * 3) {
        this.nextTickAt = nowPerf + intervalMs;
      }

      const delay = Math.max(1, Math.round(this.nextTickAt - performance.now()));
      this.stressTimer = setTimeout(tick, delay);
    };

    this.stressTimer = setTimeout(tick, 0);
  }

  public stopHighFreqPush(): void {
    this.stressRunning = false;
    if (this.stressTimer !== null) {
      clearTimeout(this.stressTimer);
      this.stressTimer = null;
    }
    this.frameTimestamps.length = 0;
  }

  private stepAndEmit(dt: number): void {
    this.elapsedSec += dt;
    this.totalFrames += 1;
    const nowWall = Date.now();

    this.frameTimestamps.push(nowWall);
    const cutoff = nowWall - 1000;
    while (this.frameTimestamps.length > 0 && this.frameTimestamps[0] < cutoff) {
      this.frameTimestamps.shift();
    }

    for (let i = 0; i < UR5_JOINT_MAPPING.length; i++) {
      const mapping = UR5_JOINT_MAPPING[i];
      const prevAngle = this.jointAngles[i];
      const desired =
        mapping.defaultAngle +
        WAVE_AMPLITUDES[i] * Math.sin(this.elapsedSec * WAVE_FREQUENCIES[i] + WAVE_PHASES[i]);
      const clamped = Math.min(Math.max(desired, mapping.min), mapping.max);
      this.jointAngles[i] = clamped;

      const velocity = (clamped - prevAngle) / dt;
      const effort =
        0.8 +
        Math.abs(velocity) * 3.6 +
        Math.abs(Math.sin(clamped)) * 6.2 +
        (i === 1 ? 8.5 : 0);
      const temperature =
        mapping.defaultTemperature +
        Math.min(7.5, Math.abs(velocity) * 2.0) +
        Math.sin(this.elapsedSec * 0.4 + i) * 0.35;

      const sample = this.reusableSamples[i];
      sample.angle = clamped;
      sample.velocity = velocity;
      sample.effort = effort;
      sample.temperature = temperature;
    }

    this.reusableFrame.timestamp = nowWall;
    this.reusableFrame.rateHz = this.frameTimestamps.length;
    this.reusableFrame.latencyMs = 0;

    for (const listener of this.frameListeners) {
      listener(this.reusableFrame);
    }
  }

  onFrame(listener: (frame: TelemetryFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatus(status: ConnectionStatus) {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
