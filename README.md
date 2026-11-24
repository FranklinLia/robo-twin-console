# ROBO-TWIN CONSOLE · 机器人数字孪生与具身智能控制台

基于 **Vue 3 + TypeScript + Vite + Pinia + Three.js + URDF-Loader** 构建的 Web3D 机器人数字孪生上位机控制台，覆盖 **6 轴 URDF 模型仿真、ROS `joint_states` 语义实时遥测、正/逆运动学与轨迹规划、自然语言具身任务预览与安全执行** 全链路。

---

## 系统架构

```
+-------------------------------------------------------------------+
|                        Vue 3 UI 控制台层                           |
|  RobotViewport (3D) | TelemetryDock (Canvas/SVG) | ControlPanel   |
+---------------------------------+---------------------------------+
                                  |
                  Pinia 单一数据源 (useRobotStore)
             + 非响应式环形缓冲 (TelemetryRingBuffer)
                                  |
+---------------------------------+---------------------------------+
|  运动学与规划层                  |  数据源与具身智能适配层          |
|  - FK 正运动学 / DLS 数值 IK     |  - WsRobotDataSource (/ws)      |
|  - Halton 工作空间点云采样        |  - LocalSimDataSource           |
|  - 关节空间 / 末端直线轨迹规划    |  - 本地规则 & Gemini 4 解析     |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------+---------------------------------+
|              Node.js + Express + ws 统一服务 (server.ts)          |
|  - /ws/joint_states (20Hz ROS 语义推送 & 心跳 RTT)                |
|  - /api/sim/* (服务启停/波形控制/过温注入)                         |
|  - /api/agent/parse (可选服务端 Gemini 4 Hydrogen 结构化解析)     |
+-------------------------------------------------------------------+
```

---

## 核心功能（按路线图阶段 0～5 演进完成）

- **阶段 0 · 地基加固**：Pinia 全局状态管理、`JointState` 遥测字段扩展、`RobotDataSource` 协议边界抽象、三栏工业布局。
- **阶段 1 · 数字孪生本体**：加载 6 轴 UR5 风格 URDF 模型（`public/models/ur5_6dof.urdf`），Z-up → Y-up 坐标适配、加载失败自动降级 6 轴 Mock 机械臂、`RoomEnvironment` 环境光与接触阴影、`Raycaster` 悬停/点击连杆拾取与局部独立高亮。
- **阶段 2 · 数据流与遥测 HUD**：ROS `joint_states` 语义 WebSocket 服务（20Hz）、`CONNECTING / ONLINE / OFFLINE` 状态机与断线自动重连、非响应式固定容量环形缓冲区（`TelemetryRingBuffer`）、自绘 `<canvas>` 多通道实时波形、自绘 SVG 圆弧仪表盘、温度/限位/通信事件告警流与故障注入测试。
- **阶段 3 · 运动学与工作空间**：与 URDF 对齐的 4×4 正运动学 FK（实时校验与 Three.js `getWorldPosition()` 误差）、阻尼最小二乘（DLS）数值 IK、末端 `tool0` 坐标系可视化、Halton 工作空间可达点云、示教点记录与「关节空间插值 / 末端直线 (IK)」轨迹规划及播放控制。
- **阶段 4 · 具身智能层**：工作台语义物体（`red_cube` / `blue_cylinder` / `tray_a`）及屏幕投影标签、支持「本地确定性规则」与「服务端 Gemini 4 Hydrogen（`responseSchema` 结构化输出）」双解析引擎、安全边界拦截（防代码注入/防越界/防桌面碰撞）、3D 轨迹预览确认后执行与夹爪随动。
- **阶段 5 · 工程化与打磨**：
  - **按需渲染（On-Demand Rendering）**：相机阻尼静止与无状态变化时自动停帧，大幅降低空闲 CPU/GPU 占用。
  - **渲染与内存优化**：工作空间 2400 点云采用单 Draw Call `InstancedMesh` 渲染，共享标记几何体与材质，组件卸载完整释放 `geometry / material / texture / PMREM / renderer`。
  - **深浅主题与响应式**：支持 Dark / Light 工业主题切换与平板/窄屏自适应布局。

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务（Express + ws + Vite 中间件，端口 3000）
npm run dev

# 3. 类型检查与生产构建
npm run build

# 4. 生产模式运行
npm start
```

> 可选环境变量：如需启用「Gemini 4 (服务端)」自然语言解析，可在 `.env` 中配置 `GEMINI_API_KEY=...`（参考 `.env.example`）；未配置时默认「本地语义解析」引擎仍可完整离线运行。

---

## 快捷键清单

| 按键 | 功能 |
|---|---|
| `1` / `2` / `3` / `4` | 切换等轴测 (ISO) / 正视图 / 侧视图 / 俯视图 |
| `R` | 归零姿态 (Home Pose) |
| `Space` | 播放/暂停示教轨迹（或切换 WS 自动波形/保持） |
| `G` | 显示/隐藏地面网格 |
| `W` | 显示/隐藏工作空间点云（`InstancedMesh`） |
| `T` | 切换深色 / 浅色主题 |
