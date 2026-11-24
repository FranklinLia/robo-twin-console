import type {
  AgentParseResult,
  RobotActionCommand,
  SceneObjectItem,
} from '../types/robot';

const UNSAFE_CODE_PATTERN =
  /(eval\(|exec\(|ignore_limits|bypass|force_override|<script|rm\s+-rf|import\s+|require\()/i;

function matchSceneObject(text: string, objects: SceneObjectItem[]): SceneObjectItem | null {
  const lower = text.toLowerCase();
  for (const obj of objects) {
    if (lower.includes(obj.id.toLowerCase())) return obj;
  }
  if (/红|red|方块|工件|cube/.test(lower)) {
    return objects.find((o) => o.id === 'red_cube') ?? null;
  }
  if (/蓝|blue|料筒|圆柱|cylinder/.test(lower)) {
    return objects.find((o) => o.id === 'blue_cylinder') ?? null;
  }
  if (/料盘|托盘|tray|a\s*区|a\s*盘/.test(lower)) {
    return objects.find((o) => o.id === 'tray_a') ?? null;
  }
  return null;
}

function extractCoordinates(text: string): [number, number, number] | null {
  const match = text.match(
    /\(?\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*\)?/
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 本地确定性自然语言指令解析器：
 * 只产出受控的结构化动作原语（home / move_to / pick / place / wait），绝不生成可执行代码。
 */
export function parseIntentLocally(
  rawPrompt: string,
  sceneObjects: SceneObjectItem[]
): AgentParseResult {
  const prompt = rawPrompt.trim();
  const lower = prompt.toLowerCase();

  if (!prompt) {
    return {
      recognized: false,
      safetyBlocked: false,
      reason: '指令为空，请输入机器人控制指令（例如：「移动到 home 位姿」或「抓取红色工件放到 A 号料盘」）。',
      actions: [],
      engine: 'LOCAL_RULE',
    };
  }

  // 安全策略拦截：禁止代码注入或绕过限位指令
  if (UNSAFE_CODE_PATTERN.test(prompt)) {
    return {
      recognized: true,
      safetyBlocked: true,
      reason: '安全边界拦截：检测到疑似可执行代码或越权绕过限位关键词，已拒绝生成动作。',
      actions: [],
      engine: 'LOCAL_RULE',
    };
  }

  // 1. 回零 / Home
  if (/(home|归零|回零|复位姿态|初始姿态)/.test(lower) && !/(抓|pick|放|place)/.test(lower)) {
    return {
      recognized: true,
      safetyBlocked: false,
      reason: '解析为回零动作：各关节平滑返回 Home Pose (0°)。',
      actions: [
        {
          type: 'home',
          description: '回到 Home 位姿 (全关节归零)',
        },
      ],
      engine: 'LOCAL_RULE',
    };
  }

  // 2. 抓取并放置复合任务 (Pick & Place)
  const hasPick = /(抓|拿|吸取|pick|grab)/.test(lower);
  const hasPlace = /(放|置|搬到|移到.*盘|place|drop|put)/.test(lower);

  if (hasPick && hasPlace) {
    const parts = prompt.split(/放|置|place|drop|put|到.*盘/i);
    const pickObj =
      matchSceneObject(parts[0] ?? prompt, sceneObjects) ??
      sceneObjects.find((o) => o.kind === 'graspable') ??
      null;
    const placeObj =
      matchSceneObject(prompt.slice((parts[0] ?? '').length), sceneObjects) ??
      sceneObjects.find((o) => o.kind === 'receptacle') ??
      null;

    if (!pickObj || !placeObj) {
      return {
        recognized: false,
        safetyBlocked: false,
        reason: '未识别出有效的抓取物体或放置目标，请指明「红色工件 / 蓝色料筒 / A 号料盘」。',
        actions: [],
        engine: 'LOCAL_RULE',
      };
    }

    const actions: RobotActionCommand[] = [
      {
        type: 'move_to',
        targetId: pickObj.id,
        description: `移动至 ${pickObj.label} 上方预备点`,
      },
      {
        type: 'pick',
        targetId: pickObj.id,
        description: `夹爪闭合抓取 ${pickObj.label}`,
      },
      {
        type: 'move_to',
        targetId: placeObj.id,
        description: `搬运至 ${placeObj.label} 上方`,
      },
      {
        type: 'place',
        targetId: placeObj.id,
        description: `释放物体至 ${placeObj.label}`,
      },
    ];

    return {
      recognized: true,
      safetyBlocked: false,
      reason: `解析为 Pick & Place 任务序列：抓取 ${pickObj.label} → 放置到 ${placeObj.label}。`,
      actions,
      engine: 'LOCAL_RULE',
    };
  }

  // 3. 单纯抓取
  if (hasPick) {
    const target = matchSceneObject(prompt, sceneObjects);
    if (!target) {
      return {
        recognized: false,
        safetyBlocked: false,
        reason: '未找到要抓取的目标物体，请指定「红色工件」或「蓝色料筒」。',
        actions: [],
        engine: 'LOCAL_RULE',
      };
    }
    return {
      recognized: true,
      safetyBlocked: false,
      reason: `解析为抓取动作：移动至 ${target.label} 并抓取。`,
      actions: [
        {
          type: 'move_to',
          targetId: target.id,
          description: `接近 ${target.label}`,
        },
        {
          type: 'pick',
          targetId: target.id,
          description: `抓取 ${target.label}`,
        },
      ],
      engine: 'LOCAL_RULE',
    };
  }

  // 4. 坐标移动 / 目标移动
  const coords = extractCoordinates(prompt);
  if (coords && /(移|去|到|move|go)/.test(lower)) {
    return {
      recognized: true,
      safetyBlocked: false,
      reason: `解析为空间点移动：目标 (${coords[0].toFixed(2)}, ${coords[1].toFixed(2)}, ${coords[2].toFixed(2)}) m。`,
      actions: [
        {
          type: 'move_to',
          position: coords,
          description: `移动末端至 (${coords[0].toFixed(2)}, ${coords[1].toFixed(2)}, ${coords[2].toFixed(2)}) m`,
        },
      ],
      engine: 'LOCAL_RULE',
    };
  }

  if (/(移|去|到|对准|查看|move|go|approach)/.test(lower)) {
    const target = matchSceneObject(prompt, sceneObjects);
    if (target) {
      return {
        recognized: true,
        safetyBlocked: false,
        reason: `解析为语义目标移动：对准 ${target.label}。`,
        actions: [
          {
            type: 'move_to',
            targetId: target.id,
            description: `移动末端至 ${target.label} 作业点`,
          },
        ],
        engine: 'LOCAL_RULE',
      };
    }
  }

  // 无法识别的指令：明确反馈，绝不静默失败
  return {
    recognized: false,
    safetyBlocked: false,
    reason:
      '无法识别该自然语言指令。支持示例：「移动到 home 位姿」、「抓取红色工件放到 A 号料盘」、「移动到蓝色料筒」、「移动到 (0.3, 0.5, 0.3)」。',
    actions: [],
    engine: 'LOCAL_RULE',
  };
}
