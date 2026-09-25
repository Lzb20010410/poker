# 私局德州扑克 · poker-room

> **合规声明**：本项目为**私人朋友局用途，非商业运营，不涉及任何真实价值交换**。
> 纯虚拟筹码，无充值、无兑换、无回收、无提现功能，且不开放注册、不上架、不公开运营。
> 仓库公开仅作为开发者的技术作品集。

2-8 人在线德州扑克。房主创建房间生成 6 位配对码，其他玩家用配对码入房。PC 与手机浏览器同一套代码。

---

## 技术栈

| 层 | 选型 | 版本（已实测） |
|---|---|---|
| 语言 | TypeScript（strict） | 5.9.3 |
| 包管理 | pnpm workspaces | 9.15 |
| 前端 | React + Vite | 19.3.0 / 7.3.6 |
| 动画 | GSAP | 3.15.0 |
| 图形 | SVG + CSS（不用 Canvas/WebGL） | — |
| 联机 | Colyseus | 0.18.8（客户端 `@colyseus/sdk` 0.18.4） |
| 比牌 | pokersolver | 2.1.4 |
| 测试 | vitest | 5.0.1 |
| 运行 | Node | ≥20（开发实测 24.14） |

## 仓库结构

```
packages/
  shared/    纯规则逻辑，零 IO、零框架依赖。整个项目的命脉，100% 单测覆盖。
  server/    Colyseus 服务端。只做权威判定 + 状态同步 + 房间生命周期。
  web/       React 前端。只做渲染状态 + 播动画 + 收集操作。
scripts/
  check-arch.mjs   架构守卫，把分层铁律变成可执行检查
```

分层铁律：**游戏规则只存在于 `shared/engine`**。服务端调用它做权威判定，前端永不自行决策。

## 开发

```bash
pnpm install
pnpm dev        # 并行启动 server(:2567) + web(:5173)，手机可访问 http://<本机IP>:5173
pnpm verify     # lint + 架构守卫 + typecheck + test + build，提交前必跑
pnpm test:cov   # shared 包覆盖率（要求 100% statements）
```

## 文档

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | AI 编码代理的常驻行为规范 |
| `SPEC.md` | 架构 / 协议 / 动画 / UI 技术规格 |
| `RULES-SPEC.md` | 德州规则引擎的精确算法（边池、下注轮、状态机） |
| `TASKS.md` | 24 个任务的工作队列与验收标准 |
| `PROGRESS.md` | 进度账本 |
| `DECISIONS.md` | 技术决策记录 |

## 开发进度

M0 骨架 → M1 规则引擎与可玩 → M2 视觉 → M3 动画 → M4 打磨与部署。
详见 `PROGRESS.md`。
