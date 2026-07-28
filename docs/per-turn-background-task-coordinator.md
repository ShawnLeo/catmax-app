# Per-turn 后台任务协调器

## 目标

协调器为每个 turn 提供稳定、backend 无关的生命周期，不解析 Claude/Codex 私有协议。
Claude 的 `task_started`、`task_progress`、`task_notification` 仍由 Claude tracker 处理，
再以统一 `TurnEvent` 交给协调器。

## 模块边界

| 模块                              | 单一职责                                |
| --------------------------------- | --------------------------------------- |
| `turn/per-turn-coordinator.ts`    | 排队、ID 路由、watchdog、取消、终态保证 |
| `turn/turn-run-repository.ts`     | 持久化接口及 SQLite/内存实现            |
| `claude/background-task-state.ts` | Claude SDK 后台任务协议状态机           |
| `BackendManager`                  | 选择 adapter，并把事件广播到 renderer   |
| `messageStore`                    | 把统一事件投影为界面状态                |

协调器不依赖具体 adapter，不访问 Electron window，也不直接读写 SQLite。

## 生命周期

```text
queued
  ├─ lane 空闲 ─> running
  └─ 用户取消 ─> interrupted

running
  ├─ turn_completed(completed)   ─> completed
  ├─ turn_completed(error)       ─> error
  ├─ 用户取消 / idle watchdog    ─> cancelling
  └─ stream 抛错或漏发终态       ─> error（协调器补齐 turn_completed）

cancelling
  ├─ backend 返回终态            ─> interrupted/error
  └─ 超过 cancel grace           ─> interrupted（协调器兜底）
```

同一个 CatMax session 只有一个 active turn，其余请求进入 FIFO 队列。不同 session
可以并行。

## ID 路由

每个运行项同时维护：

- `id`：BackendManager 接收请求时生成的稳定 ID；
- `backendTurnId`：adapter 的 `turn_started` 事件给出的真实 ID；
- `requestId`：approval / agent question 的请求 ID。

interrupt、steer、热切换和问题回复都先通过协调器解析到启动该 turn 的 backend，
不依赖用户当前切换到了哪个 backend。

renderer 会把乐观进入 running 状态时生成的 `clientTurnId` 交给 BackendManager 作为
协调器 `id`。BackendManager 在调用 adapter 前移除该字段，因此首个 backend 事件到达前
也能可靠 interrupt/steer，同时不会把协调层元数据泄漏到 backend 协议。

如果 steer / hot-swap 早于首个 `turn_started`，协调器暂存一个与 backend 无关的控制
回调，绑定真实 ID 后再执行；取消中的 turn 会丢弃尚未派发的控制动作。

## 持久化与恢复

`turn_runs` 表保存状态、时间戳和最新后台任务快照。高频 token delta 使用延迟
checkpoint；任务状态、审批、错误和终态立即落盘。

桌面 App 退出后，本地 Agent SDK 子进程不能安全重连。因此启动恢复采用确定性策略：

1. 查询 `queued/running/cancelling`；
2. 将 turn 标记为 `interrupted`；
3. 将仍为 `running` 的后台任务标记为 `stopped`；
4. 保留快照供诊断或 UI 查询。

终态记录默认保留七天，恢复时自动清理过期记录。

## 超时

- idle timeout：默认 30 分钟无任何 `TurnEvent` 后请求 backend 中断；
- cancel grace：默认 15 秒，backend 未返回终态时由协调器补齐 `interrupted`；
- `task_progress`、文本 delta、审批等所有事件都会刷新 idle watchdog。

这些值集中定义在 `per-turn-coordinator.ts`，测试可通过构造参数覆盖。

## 追加指令

运行中再次发送消息走 `backend.steerTurn`，不会创建并发 turn：

- Claude：写入当前 SDK streaming input；
- Codex：调用现有 `turn/steer`；
- 不支持 steer 的插件不展示追加发送按钮。

## 扩展约束

新增 backend 只需实现 `AgentBackend.startTurn/interrupt`；如果支持追加指令，再实现
`steer`。不要在 adapter 中复制排队、timeout 或持久化逻辑。
