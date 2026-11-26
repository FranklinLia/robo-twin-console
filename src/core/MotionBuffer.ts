/**
 * 抗抖动运动插值环形缓冲区（零 Vue 依赖 · 零高频 GC 分配）
 * 使用定长 Float64Array 存储带单调时间戳的关节弧度快照，
 * 在 60FPS 渲染帧中执行线性插值（Lerp）以平滑网络抖动。
 */
export class MotionBuffer {
  public readonly capacity: number;
  public readonly jointCount: number;
  private readonly interpolationDelayMs: number;

  private readonly timestamps: Float64Array;
  private readonly angles: Float64Array;

  private head = 0;
  private count = 0;
  private lastTimestamp = 0;
  private clockOffsetMs = 0;
  private hasClockOffset = false;

  private readonly listeners = new Set<() => void>();

  constructor(jointCount = 6, capacity = 64, interpolationDelayMs = 70) {
    this.jointCount = jointCount;
    this.capacity = capacity;
    this.interpolationDelayMs = interpolationDelayMs;
    this.timestamps = new Float64Array(capacity);
    this.angles = new Float64Array(capacity * jointCount);
  }

  /**
   * 写入一组关节目标弧度快照（直接复用底层 Float64Array 槽位）
   */
  public push(jointAngles: ArrayLike<number>, sourceTimestampMs?: number): void {
    const localNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let alignedTs: number;

    if (typeof sourceTimestampMs === 'number' && Number.isFinite(sourceTimestampMs)) {
      const measuredOffset = localNow - sourceTimestampMs;
      if (
        !this.hasClockOffset ||
        Math.abs(sourceTimestampMs + this.clockOffsetMs - localNow) > 1500
      ) {
        this.clockOffsetMs = measuredOffset;
        this.hasClockOffset = true;
      } else {
        // 缓慢跟踪时钟漂移，保留源端采样节奏以抑制到达时刻抖动
        this.clockOffsetMs += (measuredOffset - this.clockOffsetMs) * 0.05;
      }
      alignedTs = sourceTimestampMs + this.clockOffsetMs;
    } else {
      alignedTs = localNow;
    }

    if (this.count > 0 && alignedTs <= this.lastTimestamp) {
      alignedTs = this.lastTimestamp + 1;
    }
    this.lastTimestamp = alignedTs;

    this.timestamps[this.head] = alignedTs;
    const baseOffset = this.head * this.jointCount;
    for (let j = 0; j < this.jointCount; j++) {
      this.angles[baseOffset + j] = jointAngles[j] ?? 0;
    }

    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }

    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * 在当前渲染时间戳执行抗抖动线性插值（Lerp）采样
   * @returns 若缓冲区仍有未追平的未来快照（需继续 60FPS 渲染），返回 true；否则返回 false
   */
  public sample(nowMs: number, outAngles: Float64Array): boolean {
    if (this.count === 0) return false;

    const newestSlot = (this.head - 1 + this.capacity) % this.capacity;
    const newestTs = this.timestamps[newestSlot];
    const renderTime = nowMs - this.interpolationDelayMs;

    if (this.count === 1 || renderTime >= newestTs) {
      const base = newestSlot * this.jointCount;
      for (let j = 0; j < this.jointCount; j++) {
        outAngles[j] = this.angles[base + j];
      }
      return renderTime < newestTs;
    }

    const startSlot = this.count < this.capacity ? 0 : this.head;
    const oldestTs = this.timestamps[startSlot];
    if (renderTime <= oldestTs) {
      const base = startSlot * this.jointCount;
      for (let j = 0; j < this.jointCount; j++) {
        outAngles[j] = this.angles[base + j];
      }
      return true;
    }

    // 在有序环形缓冲区中定位 bracketing 区间 [slotA, slotB]
    let slotA = startSlot;
    let slotB = (startSlot + 1) % this.capacity;

    for (let i = 0; i < this.count - 1; i++) {
      const curSlot = (startSlot + i) % this.capacity;
      const nextSlot = (startSlot + i + 1) % this.capacity;
      const t0 = this.timestamps[curSlot];
      const t1 = this.timestamps[nextSlot];
      if (renderTime >= t0 && renderTime <= t1) {
        slotA = curSlot;
        slotB = nextSlot;
        break;
      }
    }

    const tA = this.timestamps[slotA];
    const tB = this.timestamps[slotB];
    const span = tB - tA;
    const alpha = span > 1e-6 ? Math.min(Math.max((renderTime - tA) / span, 0), 1) : 1;

    const baseA = slotA * this.jointCount;
    const baseB = slotB * this.jointCount;
    for (let j = 0; j < this.jointCount; j++) {
      const a0 = this.angles[baseA + j];
      const a1 = this.angles[baseB + j];
      outAngles[j] = a0 + (a1 - a0) * alpha;
    }

    return true;
  }

  public getLatest(outAngles: Float64Array): boolean {
    if (this.count === 0) return false;
    const newestSlot = (this.head - 1 + this.capacity) % this.capacity;
    const base = newestSlot * this.jointCount;
    for (let j = 0; j < this.jointCount; j++) {
      outAngles[j] = this.angles[base + j];
    }
    return true;
  }

  public getCount(): number {
    return this.count;
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public clear(): void {
    this.head = 0;
    this.count = 0;
    this.lastTimestamp = 0;
    this.hasClockOffset = false;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const sharedMotionBuffer = new MotionBuffer(6, 64, 70);
