/**
 * 非响应式固定容量环形缓冲区（Zero unbounded allocation）
 * 专门用于高频遥测波形渲染，避免把历史时序点塞进 Vue reactive Proxy 引发内存泄漏或卡顿。
 */
export interface TelemetryPoint {
  timestamp: number;
  angles: number[];
}

export class TelemetryRingBuffer {
  private readonly capacity: number;
  private readonly channelCount: number;
  private timestamps: Float64Array;
  private series: Float32Array[];
  private head = 0;
  private count = 0;
  private revision = 0;

  constructor(channelCount = 6, capacity = 240) {
    this.channelCount = channelCount;
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.series = Array.from({ length: channelCount }, () => new Float32Array(capacity));
  }

  push(timestamp: number, angles: number[]): void {
    this.timestamps[this.head] = timestamp;
    for (let ch = 0; ch < this.channelCount; ch++) {
      this.series[ch][this.head] = angles[ch] ?? 0;
    }
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
    this.revision += 1;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.revision += 1;
  }

  getRevision(): number {
    return this.revision;
  }

  getLength(): number {
    return this.count;
  }

  getCapacity(): number {
    return this.capacity;
  }

  /**
   * 按时间从旧到新读取第 channelIndex 个通道的值到调用方复用数组，避免频繁 GC
   */
  readChannelInto(channelIndex: number, out: number[]): number {
    const len = this.count;
    const ch = this.series[channelIndex];
    if (!ch || len === 0) return 0;

    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < len; i++) {
      const idx = (start + i) % this.capacity;
      out[i] = ch[idx];
    }
    return len;
  }
}

export const sharedTelemetryBuffer = new TelemetryRingBuffer(6, 240);
