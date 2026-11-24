import { STORE_TO_URDF_JOINT } from '../config/jointMapping';
import type {
  ConnectionStatus,
  RobotDataSource,
  ServerMotionMode,
  TelemetryFrame,
} from '../types/robot';

interface RosJointStatesMsg {
  type: 'joint_states';
  header: {
    seq: number;
    stamp: number;
    frame_id: string;
  };
  name: string[];
  position: number[];
  velocity: number[];
  effort: number[];
  temperature: number[];
}

interface PongMsg {
  type: 'pong';
  clientTs: number;
  serverTs: number;
}

export class WsRobotDataSource implements RobotDataSource {
  readonly id = 'ws-joint-states';

  private url: string;
  private ws: WebSocket | null = null;
  private manualClose = false;
  private status: ConnectionStatus = 'OFFLINE';

  private frameListeners = new Set<(frame: TelemetryFrame) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastPacketAt = 0;
  private latestRttMs = 0;
  private frameTimestamps: number[] = [];

  constructor(url?: string) {
    if (url) {
      this.url = url;
    } else if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${window.location.host}/ws/joint_states`;
    } else {
      this.url = 'ws://localhost:3000/ws/joint_states';
    }
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.frameTimestamps = [];
    this.setStatus('OFFLINE');
  }

  sendJointTarget(name: string, angle: number): void {
    const urdfName = STORE_TO_URDF_JOINT[name] ?? name;
    this.sendJson({ type: 'set_joint_target', name: urdfName, angle });
  }

  sendHomeCommand(): void {
    this.sendJson({ type: 'home' });
  }

  setMotionMode(mode: ServerMotionMode): void {
    this.sendJson({ type: 'set_motion_mode', mode });
  }

  injectTemperature(name: string, temperature: number): void {
    const urdfName = STORE_TO_URDF_JOINT[name] ?? name;
    this.sendJson({ type: 'inject_temp', jointName: urdfName, temperature });
  }

  clearFaults(): void {
    this.sendJson({ type: 'clear_faults' });
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

  private openSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus('CONNECTING');
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastPacketAt = Date.now();
      this.setStatus('ONLINE');
      this.startHeartbeat();
      this.sendJson({ type: 'ping', clientTs: Date.now() });
    };

    socket.onmessage = (event) => {
      this.lastPacketAt = Date.now();
      this.handleRawMessage(String(event.data));
    };

    socket.onerror = () => {
      // onclose 会紧接着触发状态流转与重连
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.frameTimestamps = [];
      this.setStatus('OFFLINE');
      if (!this.manualClose) {
        this.scheduleReconnect();
      }
    };
  }

  private handleRawMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as RosJointStatesMsg | PongMsg;
      if (msg.type === 'pong') {
        this.latestRttMs = Math.max(1, Date.now() - msg.clientTs);
        return;
      }

      if (msg.type === 'joint_states') {
        const now = Date.now();
        this.frameTimestamps.push(now);
        const cutoff = now - 1000;
        while (this.frameTimestamps.length > 0 && this.frameTimestamps[0] < cutoff) {
          this.frameTimestamps.shift();
        }

        const joints = msg.name.map((jointName, idx) => ({
          name: jointName,
          angle: msg.position[idx] ?? 0,
          velocity: msg.velocity[idx] ?? 0,
          effort: msg.effort[idx] ?? 0,
          temperature: msg.temperature[idx] ?? 35,
        }));

        const frame: TelemetryFrame = {
          timestamp: msg.header?.stamp ?? now,
          joints,
          rateHz: this.frameTimestamps.length,
          latencyMs: this.latestRttMs,
        };

        for (const listener of this.frameListeners) {
          listener(frame);
        }
      }
    } catch {
      // ignore invalid frames
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPacketAt > 4500) {
        this.ws.close();
        return;
      }
      this.sendJson({ type: 'ping', clientTs: Date.now() });
    }, 2000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(3000, 1200 + this.reconnectAttempt * 400);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.manualClose) {
        this.openSocket();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) {
      listener(next);
    }
  }
}
