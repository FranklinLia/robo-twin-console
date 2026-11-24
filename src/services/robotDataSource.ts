import type {
  ConnectionStatus,
  RobotDataSource,
  TelemetryFrame,
} from '../types/robot';

/**
 * Phase 0 本地仿真数据源占位实现：
 * 保持手动滑块即时响应，同时固定协议接口边界。
 * 后续阶段 2 接入 Mock WebSocket 或真实上位机时，只需实现 RobotDataSource 并替换注入即可。
 */
export class LocalSimDataSource implements RobotDataSource {
  readonly id = 'local-sim';
  private frameListeners = new Set<(frame: TelemetryFrame) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  async connect(): Promise<void> {
    this.emitStatus('LOCAL_SIM');
  }

  disconnect(): void {
    this.emitStatus('OFFLINE');
  }

  sendJointTarget(_name: string, _angle: number): void {
    // 本地模式由 store 直接写入，后续在线模式下发控制指令给上位机
  }

  sendHomeCommand(): void {
    // 本地模式由 store 直接归零
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
