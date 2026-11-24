import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  parseIntentWithGemini,
  type SceneObjectDescriptor,
} from './server/agentParser.ts';
import { MockRobotWsServer, type ServerMotionMode } from './server/mockRobotServer.ts';

const PORT = 3000;
const HOST = '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

async function bootstrap() {
  const app = express();
  app.use(express.json());

  const mockWsServer = new MockRobotWsServer();

  app.post('/api/agent/parse', async (req, res) => {
    const prompt = String(req.body?.prompt ?? '').trim();
    const sceneObjects = (req.body?.sceneObjects ?? []) as SceneObjectDescriptor[];
    if (!prompt) {
      res.status(400).json({ error: '请输入自然语言指令' });
      return;
    }
    try {
      const result = await parseIntentWithGemini(prompt, sceneObjects);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // 本地 Mock 机器人服务管理端点（支持从控制台模拟服务启停与温度注入）
  app.get('/api/sim/status', (_req, res) => {
    res.json(mockWsServer.getStatus());
  });

  app.post('/api/sim/stop', (_req, res) => {
    mockWsServer.stopService();
    res.json(mockWsServer.getStatus());
  });

  app.post('/api/sim/start', (_req, res) => {
    mockWsServer.startService();
    res.json(mockWsServer.getStatus());
  });

  app.post('/api/sim/motion', (req, res) => {
    const mode = req.body?.mode as ServerMotionMode | undefined;
    if (mode === 'WAVE_DEMO' || mode === 'HOLD') {
      mockWsServer.setMotionMode(mode);
    }
    res.json(mockWsServer.getStatus());
  });

  app.post('/api/sim/inject-temp', (req, res) => {
    const jointName = String(req.body?.jointName ?? 'shoulder_lift_joint');
    const temperature = Number(req.body?.temperature ?? 86.5);
    const updated = mockWsServer.injectTemperature(jointName, temperature);
    res.status(updated ? 200 : 404).json({ ok: updated, ...mockWsServer.getStatus() });
  });

  app.post('/api/sim/clear-faults', (_req, res) => {
    mockWsServer.clearFaults();
    res.json(mockWsServer.getStatus());
  });

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*splat', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = createServer(app);

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws/joint_states')) {
      mockWsServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[robo-twin-console] listening on http://${HOST}:${PORT} (ws: /ws/joint_states)`);
  });

  const shutdown = () => {
    mockWsServer.dispose();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap();
