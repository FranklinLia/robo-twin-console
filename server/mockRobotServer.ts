import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export type ServerMotionMode = 'WAVE_DEMO' | 'HOLD';

interface SimJoint {
  urdfName: string;
  angle: number;
  targetAngle: number;
  velocity: number;
  effort: number;
  baseTemperature: number;
  injectedTemperature: number | null;
  min: number;
  max: number;
  waveAmp: number;
  waveFreq: number;
  wavePhase: number;
}

export interface RosJointStatesPayload {
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

export class MockRobotWsServer {
  private wss: WebSocketServer;
  private isEnabled = true;
  private motionMode: ServerMotionMode = 'WAVE_DEMO';
  private rateHz = 20;
  private seq = 0;
  private elapsedSec = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private joints: SimJoint[] = [
    {
      urdfName: 'shoulder_pan_joint',
      angle: 0,
      targetAngle: 0,
      velocity: 0,
      effort: 1.2,
      baseTemperature: 34.4,
      injectedTemperature: null,
      min: -3.1416,
      max: 3.1416,
      waveAmp: 0.75,
      waveFreq: 0.45,
      wavePhase: 0,
    },
    {
      urdfName: 'shoulder_lift_joint',
      angle: -0.35,
      targetAngle: -0.35,
      velocity: 0,
      effort: 18.4,
      baseTemperature: 38.6,
      injectedTemperature: null,
      min: -2.3562,
      max: 2.3562,
      waveAmp: 0.35,
      waveFreq: 0.6,
      wavePhase: 0.7,
    },
    {
      urdfName: 'elbow_joint',
      angle: 0.85,
      targetAngle: 0.85,
      velocity: 0,
      effort: 11.2,
      baseTemperature: 36.8,
      injectedTemperature: null,
      min: -2.618,
      max: 2.618,
      waveAmp: 0.45,
      waveFreq: 0.7,
      wavePhase: 1.4,
    },
    {
      urdfName: 'wrist_1_joint',
      angle: -0.5,
      targetAngle: -0.5,
      velocity: 0,
      effort: 3.6,
      baseTemperature: 35.1,
      injectedTemperature: null,
      min: -3.1416,
      max: 3.1416,
      waveAmp: 0.55,
      waveFreq: 0.85,
      wavePhase: 2.1,
    },
    {
      urdfName: 'wrist_2_joint',
      angle: 0.45,
      targetAngle: 0.45,
      velocity: 0,
      effort: 2.1,
      baseTemperature: 34.5,
      injectedTemperature: null,
      min: -3.1416,
      max: 3.1416,
      waveAmp: 0.65,
      waveFreq: 0.95,
      wavePhase: 0.4,
    },
    {
      urdfName: 'wrist_3_joint',
      angle: 0,
      targetAngle: 0,
      velocity: 0,
      effort: 0.8,
      baseTemperature: 33.7,
      injectedTemperature: null,
      min: -3.1416,
      max: 3.1416,
      waveAmp: 1.2,
      waveFreq: 1.1,
      wavePhase: 1.1,
    },
  ];

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        this.handleClientMessage(ws, raw.toString());
      });
      // 建连后立即推送一帧初始状态
      ws.send(JSON.stringify(this.buildJointStatesPayload()));
    });
    this.startLoop();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.isEnabled) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  stopService(): void {
    this.isEnabled = false;
    for (const client of this.wss.clients) {
      client.close(1001, 'Mock robot WS server stopped');
    }
  }

  startService(): void {
    this.isEnabled = true;
  }

  setMotionMode(mode: ServerMotionMode): void {
    this.motionMode = mode;
    if (mode === 'HOLD') {
      for (const joint of this.joints) {
        joint.targetAngle = joint.angle;
      }
    }
  }

  injectTemperature(urdfJointName: string, temperature: number): boolean {
    const target = this.joints.find((j) => j.urdfName === urdfJointName);
    if (!target) return false;
    target.injectedTemperature = temperature;
    return true;
  }

  clearFaults(): void {
    for (const joint of this.joints) {
      joint.injectedTemperature = null;
    }
  }

  getStatus() {
    return {
      wsRunning: this.isEnabled,
      motionMode: this.motionMode,
      rateHz: this.rateHz,
      clientCount: this.wss.clients.size,
    };
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.stopService();
    this.wss.close();
  }

  private startLoop(): void {
    const dt = 1 / this.rateHz;
    this.tickTimer = setInterval(() => {
      this.stepSimulation(dt);
      if (!this.isEnabled || this.wss.clients.size === 0) return;

      const payload = JSON.stringify(this.buildJointStatesPayload());
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    }, Math.round(1000 / this.rateHz));
  }

  private stepSimulation(dt: number): void {
    this.elapsedSec += dt;

    for (let i = 0; i < this.joints.length; i++) {
      const joint = this.joints[i];
      const prevAngle = joint.angle;

      if (this.motionMode === 'WAVE_DEMO') {
        const baseOffset = i === 1 ? -0.35 : i === 2 ? 0.85 : i === 3 ? -0.5 : i === 4 ? 0.45 : 0;
        const desired =
          baseOffset +
          joint.waveAmp * Math.sin(this.elapsedSec * joint.waveFreq + joint.wavePhase);
        joint.angle = Math.min(Math.max(desired, joint.min), joint.max);
        joint.targetAngle = joint.angle;
      } else {
        const diff = joint.targetAngle - joint.angle;
        joint.angle += diff * Math.min(1, dt * 8);
      }

      joint.velocity = (joint.angle - prevAngle) / dt;
      const dynamicLoad = Math.abs(joint.velocity) * 3.8 + Math.abs(Math.sin(joint.angle)) * 6.5;
      joint.effort = Number((0.6 + dynamicLoad + (i === 1 ? 8.5 : 0)).toFixed(2));

      if (joint.injectedTemperature === null) {
        const thermalDrift = Math.min(8, Math.abs(joint.velocity) * 2.2);
        joint.baseTemperature = Number(
          (33.5 + i * 0.8 + thermalDrift + Math.sin(this.elapsedSec * 0.3 + i) * 0.4).toFixed(1)
        );
      }
    }
  }

  private buildJointStatesPayload(): RosJointStatesPayload {
    this.seq += 1;
    return {
      type: 'joint_states',
      header: {
        seq: this.seq,
        stamp: Date.now(),
        frame_id: 'base_link',
      },
      name: this.joints.map((j) => j.urdfName),
      position: this.joints.map((j) => Number(j.angle.toFixed(5))),
      velocity: this.joints.map((j) => Number(j.velocity.toFixed(4))),
      effort: this.joints.map((j) => j.effort),
      temperature: this.joints.map((j) =>
        Number((j.injectedTemperature ?? j.baseTemperature).toFixed(1))
      ),
    };
  }

  private handleClientMessage(ws: WebSocket, raw: string): void {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (msg.type === 'ping' && typeof msg.clientTs === 'number') {
        ws.send(
          JSON.stringify({
            type: 'pong',
            clientTs: msg.clientTs,
            serverTs: Date.now(),
          })
        );
        return;
      }

      if (
        msg.type === 'set_joint_target' &&
        typeof msg.name === 'string' &&
        typeof msg.angle === 'number'
      ) {
        const joint = this.joints.find((j) => j.urdfName === msg.name);
        if (joint) {
          this.motionMode = 'HOLD';
          joint.targetAngle = Math.min(Math.max(msg.angle, joint.min), joint.max);
          joint.angle = joint.targetAngle;
        }
        return;
      }

      if (msg.type === 'home') {
        this.motionMode = 'HOLD';
        for (const joint of this.joints) {
          joint.targetAngle = 0;
          joint.angle = 0;
          joint.velocity = 0;
        }
        return;
      }

      if (msg.type === 'set_motion_mode' && (msg.mode === 'WAVE_DEMO' || msg.mode === 'HOLD')) {
        this.setMotionMode(msg.mode);
        return;
      }

      if (
        msg.type === 'inject_temp' &&
        typeof msg.jointName === 'string' &&
        typeof msg.temperature === 'number'
      ) {
        this.injectTemperature(msg.jointName, msg.temperature);
        return;
      }

      if (msg.type === 'clear_faults') {
        this.clearFaults();
      }
    } catch {
      // ignore malformed client frames
    }
  }
}
