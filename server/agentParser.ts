import { GoogleGenAI, Type } from '@google/genai';

export interface SceneObjectDescriptor {
  id: string;
  label: string;
  graspPoint: [number, number, number];
  kind: 'graspable' | 'receptacle';
}

export interface ParsedRobotAction {
  type: 'home' | 'move_to' | 'pick' | 'place' | 'wait';
  targetId?: string;
  position?: [number, number, number];
  durationMs?: number;
  description: string;
}

export interface AgentParseResponse {
  recognized: boolean;
  safetyBlocked: boolean;
  reason: string;
  actions: ParsedRobotAction[];
}

export async function parseIntentWithGemini(
  prompt: string,
  sceneObjects: SceneObjectDescriptor[]
): Promise<AgentParseResponse> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('服务端未配置 GEMINI_API_KEY，请在 Secrets 中配置或切换为「本地语义解析」。');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const sceneSummary = sceneObjects
    .map(
      (o) =>
        `- id: "${o.id}", label: "${o.label}", kind: "${o.kind}", point: [${o.graspPoint.join(', ')}]`
    )
    .join('\n');

  const systemInstruction = `You are a robotics task planner for a 6-DOF UR5 manipulator in a Three.js Y-up workspace.
Convert the user's natural language command into a safe, structured sequence of robot action primitives.
NEVER generate executable code. ONLY output structured action primitives from: home, move_to, pick, place, wait.

Known semantic scene objects:
${sceneSummary}

Workspace safety limits:
- Y (height) must be >= 0.05 m (never go underground).
- Radial reach from shoulder (0, 0.16, 0) must be <= 0.90 m.
- If the request is ambiguous, unrelated to robot control, asks for raw code execution, or violates safety limits, set recognized=false or safetyBlocked=true with a clear Chinese reason and empty actions array.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          recognized: { type: Type.BOOLEAN },
          safetyBlocked: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
          actions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                type: {
                  type: Type.STRING,
                  description: 'One of: home, move_to, pick, place, wait',
                },
                targetId: { type: Type.STRING },
                position: {
                  type: Type.ARRAY,
                  items: { type: Type.NUMBER },
                },
                durationMs: { type: Type.NUMBER },
                description: { type: Type.STRING },
              },
              required: ['type', 'description'],
            },
          },
        },
        required: ['recognized', 'safetyBlocked', 'reason', 'actions'],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as AgentParseResponse;
  return parsed;
}
