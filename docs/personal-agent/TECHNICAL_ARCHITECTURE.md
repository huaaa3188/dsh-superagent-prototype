# 基于 `dsh-superagent-prototype` 的个人智能伴侣完整技术架构方案

**项目名称**：Project Aura (Personal Super-Agent)  
**基座工程**：`dsh-superagent`（DeepSeek Harness 插件 Bundle）  
**核心参考**：[`001-domain.md`](../001-domain.md) · [`002-authorization.md`](../002-authorization.md) · [`003-execution.md`](../003-execution.md) · [`004-prompts.md`](../004-prompts.md) · [`006-deployment.md`](../006-deployment.md) · [`007-architecture.md`](../007-architecture.md) · [`008-cookbook.md`](../008-cookbook.md)  
**部署环境**：美西 VPS（Ubuntu 22.04+ LTS · Node.js 22.19+ · DeepSeek Harness · tmux）

---

## 1. 架构对齐：如何正确复用 `dsh-superagent` 核心引擎？

`dsh-superagent-prototype` 并非一个简单的“聊天机器人脚手架”，而是一个构建在 **DeepSeek Harness (DSH)** 与 **Cordis 微内核**之上的、具备严格领域模型（Domain-Driven）的生产级多会话调度系统。

要以最小改动、最高可靠性将其改造为个人全天候智能伴侣，**绝不能绕过其核心引擎另写一套 `Router` 或状态表**，而应当将个人助手的业务诉求精确映射到其现有架构组件上：

### 1.1 领域模型与组件映射矩阵

| 个人助手诉求 | 仓库原生概念 / 模块 | 改造与复用方式 | 改动量 |
| :--- | :--- | :--- | :--- |
| **Telegram 消息与按钮接入** | [`SourceKind`](../../src/sources/kind.ts) (`src/sources/telegram*.ts`) | 遵循 [`008-cookbook.md`](../008-cookbook.md) 新增 `telegram` SourceKind；通过 `tg-cli` 轮询私聊/Topic 消息与 `callback_query` 按钮点击，转换为标准 [`Trigger`](../../src/core/model.ts) | 🟢 新增独立插件模块 |
| **宿主白名单与防刷拦截** | [`Policy.gate`](../../src/policy.ts) + `SourceKind.scope` + `SourceKind.policy` | 在 `telegramKind.policy` 中声明 `allowed`（宿主 Telegram 数字 ID）与 `bots`（如定时触发器 `cron-bot`）；非白名单消息在 Gate 层确定性拦截，零 Token 损耗 | ⚪️ 零核心改动（配置化） |
| **前台路由 vs 后台异步解耦** | **Main Session (`orchestrator`)** + **[`DshExecutor`](../../src/executor/dsh.ts) (`worker-<ticketId>`)** | 主 Session 使用 `dsh-superagent-router` Preset，仅调 `orchestrator_route` 派单和 `orchestrator_reply` 交付；耗时工作在独立的 `worker-<ticketId>` Session 与 `<stateDir>/work/<shortName>` 目录中执行，超 5 秒命令自动转入后台 Job | ⚪️ 零核心改动（完全复用） |
| **多轮追问与按钮回调直达** | **[`Subscription`](../001-domain.md) Fan-out (`Intake`)** | 同一 Telegram 对话或针对某条工单消息的回复/按钮点击，共享同一 `ThreadRef` (`telegram:<chatId>:<rootId>`)；`Engine.receive` 自动将其扇出（Fan-out）给订阅该线程的 `Ticket` Worker，无需重复 `Eval` | ⚪️ 零核心改动（完全复用） |
| **L3 高危操作审批卡片** | **`Attention` (`human_action`)** + [`Outbox`](../../src/app/outbox.ts) (`purpose: 'attention'`) | Worker 遇到外发邮件/删除日程等 L3 动作时，调用 `orchestrator_report(state: 'progress', human_action: ...)`；主 Session 调用 `orchestrator_reply(purpose: 'attention')`；`sendTelegram` 解析动作指令并渲染 Inline Keyboard 审批按钮 | 🟢 在 `telegram-channel.ts` 中支持按钮渲染 |
| **08:00 晨间主动简报** | **Proactive Rule (`Policy.rules`)** + **Bot Trigger (`via: 'bot'`)** | 系统定时器（Cron）通过 `tg-cli` 注入一条 `actor: { id: 'cron-bot' }` 的触发事件 → Gate 识别为 `inferred` 候选 → 主 Session 按启用的 `morning-briefing` 规则评估并创建晨报 `Ticket`（支持先 `observe` 后 `auto`） | 🟢 1 条定时命令 + 1 条 Policy 规则 |
| **三层共生记忆 (Living Memory)** | **L1: [`Prompts`](../../src/app/prompts.ts) (Team Sections / Skills)**<br>**L2: [`Store`](../../src/app/store.ts) (`orchestrator.sqlite`)**<br>**L3: `<stateDir>/knowledge/`** | L1 个人画像存入带版本控制的 Team Sections 与自定义 Skill；L2 活跃状态直接复用 SQLite 中的 Open/Idle `Tickets` 与 `KV`；L3 历史研报与笔记通过 `prepare` 脚本挂载到每个 Worker 目录 | 🟢 配置 Prompt 与 `prepare` 脚本 |
| **日历/邮件/检索外部工具** | **[`Commands`](../../src/infra/commands.ts) + `<stateDir>/worker-bin` Shims + `skills/`** | 参照 `gh` 与 `lark-cli` 模式，提供 `tg-cli`、`gcal-cli`、`mail-cli` 命令行工具及配套 `SKILL.md`；Worker 通过 Bash 调用，超 5 秒自动转后台 Job，内置 `@deepseek-ai/dsh-tool-web` 支持联网搜索 | 🟡 编写轻量 CLI 脚本与 Skill 文档 |

---

## 2. 代码树规划（贴合仓库现有结构与 `tests/docs.spec.ts` 校验规范）

> [!IMPORTANT]
> 本仓库 [`tests/docs.spec.ts`](../../tests/docs.spec.ts#L58-L67) 强制校验：`src/` 下的每一个 `.ts` 文件与 `tests/` 下的每一个 `.spec.ts` 文件，都必须登记在 [`docs/007-architecture.md`](../007-architecture.md) 的 `## Modules` 和 `## Tests` 表格中。新增模块时必须同步更新 `007-architecture.md`。

```text
dsh-superagent-prototype/
├── cordis.patch.yml                      # [修改] 新增 dsh-superagent-telegram 插件条目 (默认 disabled: true)
├── package.json                          # [修改] exports 新增 "./telegram-watch": "./lib/telegram-watch.js"
├── tsdown.config.ts                      # [修改] entry 新增 "telegram-watch": "src/sources/telegram.ts"
├── scripts/
│   ├── dsh-superagent                    # [复用] 原生 tmux 进程启停、健康检查与状态探测脚本
│   └── aura-cli/                         # [新增] 部署到 ~/.local/bin 的外部受控 CLI 工具脚本集
│       ├── tg-cli                        # Telegram Bot API 幂等收发与本地定时事件注入 CLI
│       ├── gcal-cli                      # Google Calendar 日程查询与冲突检测 CLI
│       └── mail-cli                      # IMAP/Gmail 邮件读取、草稿创建与受控发送 CLI
├── skills/
│   ├── dsh-superagent-feishu/            # [保留]
│   ├── dsh-superagent-github/            # [保留]
│   └── dsh-superagent-telegram/          # [新增] Telegram 上下文读取与个人工具集交互技能说明
│       └── SKILL.md
├── src/
│   ├── kv.ts                             # [修改] 新增 KV.telegram 游标与话题缓存键定义
│   └── sources/
│       ├── telegram.ts                   # [新增] Telegram SourceKind 定义、Policy 声明与轮询主循环
│       ├── telegram-trigger.ts           # [新增] Telegram 消息 / callback_query 到 Trigger 的确定性转换
│       ├── telegram-channel.ts           # [新增] Outbox 发送适配器 (支持幂等发送、原地更新与内联审批按钮)
│       └── telegram-read.ts              # [新增] ThreadContext 实现，供评估器与 Worker 读取上下文
├── tests/
│   └── telegram.spec.ts                  # [新增] 覆盖转换、轮询游标、Scope 过滤、Outbox 发送与按钮回调的单元测试
└── docs/
    ├── 007-architecture.md               # [修改] 在 Modules 与 Tests 表中登记 telegram 相关模块与测试
    └── personal-agent/                   # [当前目录] Project Aura 产品与技术设计文档集
```

---

## 3. 核心模块详细设计（遵循 `008-cookbook.md`）

### 3.1 领域映射契约 (Domain Mapping)

在编写代码前，先确立不可变的持久化 ID 与地址映射规则（参见 [`008-cookbook.md` 第 1 步](../008-cookbook.md#L19-L30)）：

| 领域概念 | Telegram 映射规则 | 说明 |
| :--- | :--- | :--- |
| **`source`** | `'telegram'` | 全局唯一 Source 标识 |
| **`Trigger.id`** | `key('telegram', updateOrMsgId)` | 普通消息取 `${chatId}:${messageId}`；按钮点击取 `cb:${callbackQueryId}`；编辑消息附加 `:edit:${editDate}`，保证 `Engine.receive` 幂等去重 |
| **`ThreadRef.id`** | `${chatId}:${rootMessageId}` | 将同一根消息下的回复串（Reply Chain）、Forum Topic（`message_thread_id`）以及点击该消息下方的 Inline 按钮全部归入同一个 `Thread` |
| **`ActorRef.id`** | 发送者 Telegram 数字 ID 字符串（如 `'123456789'`）或 `'cron-bot'` | 与 `policy.sources.telegram.allowed` 及 `bots` 列表比对 |
| **`ChannelRef.address`** | `{ chatId, messageId, threadId?, direct: 'true' \| 'false' }` | 记录回复目标；`Outbox` 通过它向原消息所在线程回复或挂载按钮 |
| **Receiving Scope (`row`)** | `'direct'`（私聊）、`<chatId>`（已配置群组）或 `'other'` | 对应准入表（Admission Table）的行 ID |

---

### 3.2 注册持久化键值 (`src/kv.ts`)

[`tests/store.spec.ts`](../../tests/store.spec.ts) 要求所有 `KV` 字面量集中在 [`src/kv.ts`](../../src/kv.ts) 中定义。为 Telegram Source 增加游标与本地消息缓存键：

```ts
// src/kv.ts 中新增 telegram 命名空间
export const KV = {
  // ... 保持现有 store, settings, prompts, runtime, sessions, queues, sources, github, feishu 不变
  /**
   * Telegram Source: Bot API getUpdates offset cursor, and per-thread cached messages for bounded threadContext reads.
   */
  telegram: {
    offset: record<number>('telegram-offset'),
    threadMessages: family<{ id: string; from: string; at: string; text: string; bot?: true; reply_to?: string }[], [thread: string]>('telegram-thread:'),
  },
}
```

---

### 3.3 外部传输层：`tg-cli` 契约设计

为什么不直接在プラグイン进程里引第三方 `grammY` 包裸跑，而是像 Feishu (`lark-cli`) 和 GitHub (`gh`) 一样走 [`Commands.run`](../../src/infra/commands.ts)？
1. **凭证隔离**：[`006-deployment.md`](../006-deployment.md#L218) 明确规定，系统会清理含 `TOKEN`/`KEY`/`SECRET` 的环境变量；将 Bot Token 封装在 `~/.config/tg-bot/config.json` 与 `~/.local/bin/tg-bot` 包装脚本中，Worker 无法直接窃取裸 Token。
2. **高度可测试性**：完全遵循 [`tests/sources.spec.ts`](../../tests/sources.spec.ts) 模式，只需 `vi.spyOn(commands, 'run')` 即可在毫秒级完成全部边界测试（网络超时、403 用户屏蔽、`gone` 永久失败、游标中断恢复）。

`tg-cli` 支持以下 3 个标准子命令（输出严格 JSON）：

1. **拉取增量事件**：
   ```sh
   tg-cli pull --after <offset> --timeout 10 --json
   # 输出:
   # {
   #   "me": { "id": "999888777", "username": "aura_personal_bot" },
   #   "items": [
   #     {
   #       "update_id": 10042,
   #       "message_id": "501",
   #       "chat_id": "123456789",
   #       "chat_type": "private",
   #       "root_id": "501",
   #       "reply_to_id": undefined,
   #       "sender": { "id": "123456789", "name": "Runhua", "bot": false },
   #       "mentions_me": false,
   #       "text": "帮我调研一下 2026 年固态电池量产进展，整理成报告",
   #       "at": "2026-11-03T23:50:00.000Z"
   #     }
   #   ],
   #   "next": 10043
   # }
   ```
   > **注**：当用户在 Telegram 点击内联审批按钮（如 `[ ✓ 确认发送 ]`）时，`tg-cli pull` 将 `callback_query` 归一化为一条 `root_id` 指向原卡片根消息、`reply_to_id` 指向卡片消息、`text` 为回调指令（如 `[ACTION:approve_send]`）的事件，并自动调用 `answerCallbackQuery` 消除按钮加载态。

2. **幂等发送与按钮渲染**：
   ```sh
   tg-cli reply --chat-id <chatId> --to <messageId> --key <outboundMessageId> --kind <acknowledgement|reply|notice> --markdown <text>
   ```
   * `tg-cli` 内部维护轻量幂等表（按 `--key <message.id>` 去重），防止 `Outbox` 网络重试时重复发消息。
   * 当 `text` 中包含结构化按钮标记（如末尾附带 `<!-- buttons: [{"label":"✓ 确认执行","data":"approve"},{"label":"✕ 放弃","data":"reject"}] -->`）时，自动转换为 Telegram `InlineKeyboardMarkup`。
   * 若目标对话已被删除或用户已封禁机器人（Telegram HTTP 400 `chat not found` / 403 `bot was blocked by the user`），在 stderr 输出 `{"error": {"code": 410, "message": "Chat gone"}}` 并以非零退出码返回，供 Channel 识别为 `'gone'`。

3. **注入本地定时触发事件（供 Cron 晨报使用）**：
   ```sh
   tg-cli inject --chat-id <hostChatId> --sender-id cron-bot --bot --text "[CRON:morning-briefing] 请生成今日 08:00 晨间简报"
   ```
   将定时事件写入 `tg-cli` 本地待拉取队列，由下一次 `tg-cli pull` 统一读出并进入 `Engine.receive`，从而百分之百复用 `dsh-superagent` 的 `Trigger` → `Eval` → `Mandate` → `Ticket` 审计链路。

---

### 3.4 事件转换器 (`src/sources/telegram-trigger.ts`)

```ts
/** Normalizes Telegram Bot updates (messages, replies, and inline button callbacks) into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'telegram'

export const TelegramItemSchema = z.looseObject({
  update_id: z.number().int(),
  event_id: z.string().min(1).optional(),
  message_id: z.string().min(1),
  chat_id: z.string().min(1),
  chat_type: z.enum(['private', 'group', 'supergroup', 'channel']),
  root_id: z.string().min(1).optional(),
  reply_to_id: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  sender: z.looseObject({
    id: z.string().min(1),
    name: z.string().optional(),
    bot: z.boolean().default(false),
  }),
  mentions_me: z.boolean().default(false),
  text: z.string(),
  at: z.string(),
})
export type TelegramItem = z.infer<typeof TelegramItemSchema>

export const telegramTriggerId = (chatId: string, eventOrMsgId: string): string =>
  key(SOURCE, `${chatId}:${eventOrMsgId}`)

export const telegramThreadId = (chatId: string, rootId: string | undefined, messageId: string): string =>
  `${chatId}:${rootId ?? messageId}`

export const telegramChannel = (chatId: string, messageId: string, direct: boolean, threadId?: string): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${chatId}`,
  address: {
    chatId,
    messageId,
    direct: direct ? 'true' : 'false',
    ...(threadId ? { threadId } : {}),
  },
})

/** Converts one validated Telegram item into a Trigger; drops messages sent by the bot itself. */
export function telegramTrigger(item: TelegramItem, botId: string): Trigger | undefined {
  if (item.sender.id === botId) return undefined
  const direct = item.chat_type === 'private'
  const root = item.root_id ?? item.thread_id ?? item.message_id
  const thread = telegramThreadId(item.chat_id, root, item.message_id)
  const eventKey = item.event_id ?? item.message_id
  return {
    id: telegramTriggerId(item.chat_id, eventKey),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: item.sender.id },
    human: !item.sender.bot,
    ...(direct ? { addressed: 'direct' as const } : item.mentions_me ? { addressed: 'mention' as const } : {}),
    at: new Date(Date.parse(item.at)).toISOString(),
    text: item.text,
    channel: telegramChannel(item.chat_id, item.message_id, direct, item.thread_id),
    meta: {
      chatId: item.chat_id,
      messageId: item.message_id,
      rootId: root,
      direct,
      mentioned: item.mentions_me,
      ...(item.reply_to_id ? { parentId: item.reply_to_id } : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(item.sender.name ? { senderName: item.sender.name } : {}),
    },
  }
}
```

---

### 3.5 出站通道与内联按钮渲染 (`src/sources/telegram-channel.ts`)

```ts
/** Telegram outbound channel: sends idempotent replies and inline approval keyboards through tg-cli. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

const gone = (error: unknown): boolean =>
  error instanceof CliError && (error.code === 410 || error.code === 403 || /chat not found|blocked by the user|deactivated/i.test(error.message))

export async function sendTelegram(
  host: Pick<SourceContext, 'commands'>,
  message: OutboundMessage,
  cli = 'tg-cli',
): Promise<'sent' | 'gone'> {
  const { chatId, messageId, threadId } = message.channel.address
  if (!chatId || !messageId) throw new Error('Missing Telegram reply target')
  const text = checkedImText(message.text)
  const args = [
    'reply',
    '--chat-id', chatId,
    '--to', messageId,
    '--key', message.id,
    '--kind', message.kind,
    '--markdown', text,
    ...(threadId ? ['--thread-id', threadId] : []),
    ...(message.ticketId ? ['--ticket-id', message.ticketId] : []),
  ]
  try {
    await host.commands.run(cli, args)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

export const telegramLink = (address: Record<string, string>): ChannelLink => ({
  url: address.chatId && address.messageId && !address.chatId.startsWith('-')
    ? `tg://openmessage?user_id=${encodeURIComponent(address.chatId)}&message_id=${encodeURIComponent(address.messageId)}`
    : '',
  label: { zh: 'Telegram 消息', en: 'Telegram message' },
  ...(address.chatId && address.messageId ? { triggerId: telegramTriggerId(address.chatId, address.messageId) } : {}),
})
```

---

### 3.6 `SourceKind` 注册与轮询主循环 (`src/sources/telegram.ts`)

完全遵循 [`008-cookbook.md`](../008-cookbook.md) 的 10 步标准实现：

```ts
/** Telegram source kind definition, policy integration, and Cordis polling plugin. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { sendTelegram, telegramLink } from './telegram-channel.ts'
import { telegramThreadContext } from './telegram-read.ts'
import { SOURCE, TelegramItemSchema, telegramTrigger, telegramTriggerId } from './telegram-trigger.ts'

const PullPageSchema = z.looseObject({
  me: z.looseObject({ id: z.string(), username: z.string().optional() }),
  items: z.array(z.unknown()).default([]),
  next: z.number().int(),
})

export const TelegramConfigSchema = z.object({
  cli: z.string().trim().min(1).default('tg-bot'),
  directMessages: z.boolean().default(true),
  chats: z.array(z.object({
    chatId: z.string().regex(/^-?[0-9]+$/),
    name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(2).max(300).default(5),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: {
    zh: '通过受控机器人 CLI 接收 Telegram 私聊、指定群组及内联按钮回调。',
    en: 'Receives Telegram direct messages, configured chats, and inline button callbacks through the bot CLI.',
  },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人的 tg-cli', en: 'Bot tg-cli' },
      hint: { zh: '命令名或绝对路径，如 ~/.local/bin/tg-bot。', en: 'Command name or absolute path, such as ~/.local/bin/tg-bot.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群组', en: 'Chats' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群 ID', en: 'Chat ID' }, pattern: '-?[0-9]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
          { value: 'all', label: { zh: '全部消息', en: 'All' } },
        ] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 300,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['telegram'],
  scope({ meta }, config) {
    if (meta.direct === true) {
      return config.directMessages
        ? { listened: true, observed: true, row: 'direct' }
        : { listened: false, reason: 'direct_messages_not_allowed' }
    }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    allowed: (address, config) =>
      telegramKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: (host, message) => sendTelegram(host, message),
    link: telegramLink,
  },
  threadContext: telegramThreadContext,
  repliesTo: trigger =>
    typeof trigger.meta.chatId === 'string' && typeof trigger.meta.parentId === 'string'
      ? telegramTriggerId(trigger.meta.chatId, trigger.meta.parentId)
      : undefined,
  policy: {
    unnamed: { person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } },
    schema: z.object({
      allowed: z.array(z.object({
        id: z.string().regex(/^[0-9]+$/),
        name: z.string().trim().max(100).optional(),
      }).strict()).default([]),
      bots: z.array(z.object({
        id: z.string().min(1),
        name: z.string().trim().max(100).optional(),
      }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Telegram 用户 (宿主白名单)', en: 'Telegram users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'User ID', en: 'User ID' }, pattern: '[0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
      { key: 'bots', type: 'rows', label: { zh: '可触发主动候选的机器人 / 定时器', en: 'Bots whose messages may become candidates' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'Bot ID (如 cron-bot)', en: 'Bot ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: {
      zh: '名单内的人私聊机器人、在群里 @ 机器人或点击审批按钮，总是明确的请求。',
      en: 'Someone on the list messaging the bot directly, mentioning it, or clicking an action button always makes an explicit request.',
    },
    rows(stored) {
      const config = TelegramConfigSchema.parse(stored)
      return [
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' },
          note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: config.directMessages, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
        ...config.chats.map(chat => ({
          id: chat.chatId,
          label: chat.name || chat.chatId,
          note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' },
        })),
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: {
        zh: '发起工单的 Telegram chat_id；工单非来自 Telegram 时为空',
        en: 'chat_id of the Telegram chat that started the ticket; empty when the ticket did not start on Telegram',
      } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
    }),
  },
}

export async function pollTelegram(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.telegram.offset) ?? 0
  const output = await ctx.commands.withSignal(signal).run('tg-cli', ['pull', '--after', String(after), '--json'])
  const page = PullPageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The Telegram Source stopped during the read')
    const parsed = TelegramItemSchema.safeParse(item)
    if (!parsed.success) { unreadable++; continue }
    const trigger = telegramTrigger(parsed.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const chat = { label: { zh: '对话', en: 'Chat' }, value: parsed.data.chat_id }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
  }
  ctx.state.set(KV.telegram.offset, page.next)
  return { read: page.items.length, unreadable }
}

export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, telegramKind)
    const controller = new AbortController()
    const running = watchTelegram(source, controller.signal)
      .catch((error: unknown) => { source.report('telegram', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watchTelegram(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('telegram', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>(SOURCE)
    if (!config) ctx.report('telegram', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollTelegram(ctx, config, signal)
        failures = 0
        ctx.report('telegram', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) {
          ctx.report('telegram', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {})
  }
}
```

---

### 3.7 共生记忆、主动晨报与 L3 权限审批配置

不需要侵入修改 `src/core/`，通过 [`004-prompts.md`](../004-prompts.md) 与 [`006-deployment.md`](../006-deployment.md) 的 Management API 即可完成配置：

#### 1. L1 核心画像与团队段落配置 (`Prompts`)
通过面板 **Prompts** 页面或 `PUT /orchestrator/api/prompts` 配置三个 Team Sections 与一个 Team Skill：
* **`Communication` 段落**：定义消息精炼规范（如中文回复、结论先行、需要 L3 审批时在 `human_action` 中附上标准按钮注释 `<!-- buttons: [...] -->`）。
* **`Ticket scope` 段落**：定义个人事务边界——只读调研与草稿拟定（L1/L2）可直接完成并报告 `ready`；涉及对外发邮件、修改/删除重要日程或外部写操作（L3）必须先调用 `orchestrator_report(state: 'progress', human_action: '...')` 暂停并等待宿主点击确认按钮。
* **`Delivery requirements` 段落**：定义长篇调研报告与会议纪要必须归档到 `$DSH_SUPERAGENT_DIR/knowledge/`（软链至 `<stateDir>/knowledge/`），并在交付消息中附上归档路径与核心摘要。
* **Team Skill (`aura-profile`)**：存放宿主的个人作息、重点项目背景、常用联系人邮箱映射及个人偏好。

#### 2. 08:00 晨间主动简报配置 (`Policy` + Cron)
1. 在 **Settings → Policy → On each Source (Telegram)** 中：
   * `allowed` 填入宿主 Telegram User ID（如 `123456789`）；
   * `bots` 填入 `{ "id": "cron-bot", "name": "Daily Scheduler" }`。
2. 在 **Settings → Policy → Rules** 中新增一条主动规则：
   * **ID**: `morning-briefing`
   * **Name**: `每日晨间简报`
   * **Instruction**: `当收到 cron-bot 发送的 [CRON:morning-briefing] 触发器时，接受任务（静默接受，不发冗余确认回执）。Worker 调用 gcal-cli 与 mail-cli 拉取今日日程、未完结工单与高优未读邮件，检测时间冲突，挑选 Top 3 杠杆待办，排版为晨报卡片并在底部附上 [✓ 确认行程] [📝 补充待办] [🔕 今日免打扰] 按钮。`
3. 在系统 Crontab 中配置每日 07:55 注入触发事件：
   ```cron
   55 7 * * * $HOME/.local/bin/tg-bot inject --chat-id 123456789 --sender-id cron-bot --bot --text "[CRON:morning-briefing] 生成今日晨间简报"
   ```
   > **渐进验证**：初期将 Eval Mode 设为 `observe`，在面板查看每日评估记录确认无误后，切换为 `auto` 正式推送。

---

## 4. 美西 VPS 部署与运维方案（对齐 `006-deployment.md`）

### 4.1 环境初始化与安装

```bash
#!/bin/bash
set -euo pipefail

# 1. 安装基础依赖 (Node 22.19+, pnpm, git 2.32+, python3, tmux, jq)
sudo apt update && sudo apt install -y curl git tmux python3 python3-pip jq

# 2. 安装 DeepSeek Harness CLI
npm install -g @deepseek-ai/dsh@0.2.1-rc.3

# 3. 构建并链接本插件 Bundle
cd ~/dsh-superagent-prototype
pnpm install && pnpm build

# 4. 创建独立的 superagent Profile (仅首次执行)
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

### 4.2 配置 `~/.dsh/profiles/superagent/cordis.patch.yml`

基于 [`examples/profile.cordis.patch.yml`](../../examples/profile.cordis.patch.yml)，启用 `dsh-superagent-telegram` 插件：

```yaml
- $ patch:
    $ target: dsh-superagent
    config:
      stateDir: /home/ubuntu/.local/share/dsh-superagent
  - $ target: dsh-superagent-telegram
    disabled: false
```

### 4.3 配置受控 CLI 与工作区 `prepare` 脚本

1. 将封装好的 `tg-bot`、`gcal-cli`、`mail-cli` 放入 `~/.local/bin/` 并赋予执行权限（配置文件存于 `~/.config/aura-agent/`，仅限当前 OS 用户只读）。
2. 启动服务（原生运行于 `tmux` 会话 `dsh-superagent` 中）：
   ```bash
   scripts/dsh-superagent start
   scripts/dsh-superagent status
   ```
3. 通过本地管理 API（或 SSH 端口转发访问 Web Panel）配置 `prepare` 脚本，使每个 Ticket 目录自动软链共享知识库 `<stateDir>/knowledge`：
   ```sh
   mkdir -p "$DSH_SUPERAGENT_DIR" &&
   mkdir -p /home/ubuntu/.local/share/dsh-superagent/knowledge &&
   ln -sfn /home/ubuntu/.local/share/dsh-superagent/knowledge "$DSH_SUPERAGENT_DIR/knowledge"
   ```

### 4.4 生产守护与容器化部署（`systemd` / `Docker` / `tmux`）

工程同时提供三种开箱即用的生产级守护方案：

1. **方案 A：`systemd` 原生前台守护（云主机首选）**
   * 使用 [`examples/dsh-superagent.service`](../../examples/dsh-superagent.service) 直接托管前台进程 `dsh --profile superagent --no-open`，支持崩溃 5 秒自动拉起（`Restart=on-failure`）以及 `SIGINT` + `TimeoutStopSec=300` 优雅停机（确保正在运行的 Worker Session 先完成当前 Step）：
     ```bash
     loginctl enable-linger "$USER"
     mkdir -p ~/.config/systemd/user
     cp examples/dsh-superagent.service ~/.config/systemd/user/
     systemctl --user daemon-reload
     systemctl --user enable --now dsh-superagent.service
     ```
2. **方案 B：`tmux` + `systemd.timer` 自愈巡检（适合交互调试与热挂接）**
   * 使用 [`examples/dsh-superagent-check.service`](../../examples/dsh-superagent-check.service) 与 [`examples/dsh-superagent-check.timer`](../../examples/dsh-superagent-check.timer) 每 5 分钟探测 `/orchestrator/api/state`：
     * `scripts/dsh-superagent status` 返回 `0` 时静默；
     * 返回 `1`（进程异常退出或无响应）时自动执行 `scripts/dsh-superagent --profile superagent --respect-stop restart` 恢复服务并重连中断的 Assignments。
3. **方案 C：Docker / Docker Compose 一键容器化部署**
   * 使用仓库根目录 [`Dockerfile`](../../Dockerfile) 与 [`examples/docker-compose.yml`](../../examples/docker-compose.yml) 一键构建并持久化挂载 `/root/.dsh` 与 `/root/.config`：
     ```bash
     docker compose -f examples/docker-compose.yml up -d --build
     ```

### 4.5 真实 Google Calendar REST API 与 IMAP/SMTP 接入配置

`scripts/aura-cli/gcal-cli` 与 `scripts/aura-cli/mail-cli` 支持**真实云端 API + 本地 JSON 双模自动切换**，且内置网络抖动指数退避重试（Exponential Backoff + Jitter）：

1. **Google Calendar REST API v3 (`~/.config/aura-agent/gcal.json`)**：
   * 支持 OAuth2 Refresh Token、Access Token 或 Google Service Account（原生 `node:crypto` RS256 JWT 签名，零外部 SDK 依赖）：
     ```json
     {
       "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
       "clientSecret": "YOUR_CLIENT_SECRET",
       "refreshToken": "YOUR_REFRESH_TOKEN",
       "calendarId": "primary",
       "timeZone": "Asia/Shanghai",
       "tzOffset": "+08:00"
     }
     ```
2. **IMAP4rev1 / SMTP 邮件客户端 (`~/.config/aura-agent/mail.json`)**：
   * 基于 Node.js 原生 `node:tls` / `node:net` 实现 IMAP4rev1（`UID SEARCH UNSEEN` / `UID FETCH` / MIME UTF-8 解码）与 SMTP（`AUTH PLAIN` / RFC 5322 UTF-8 Base64 投递），L2 草稿保存在本地，L3 外发/删除强制校验 `--approved-by`：
     ```json
     {
       "imap": { "host": "imap.gmail.com", "port": 993, "tls": true, "user": "you@gmail.com", "pass": "APP_PASSWORD" },
       "smtp": { "host": "smtp.gmail.com", "port": 465, "tls": true, "user": "you@gmail.com", "pass": "APP_PASSWORD", "from": "you@gmail.com" }
     }
     ```
   * 未配置上述云端凭据时，自动回退至 `<stateDir>/aura-data/` 下的本地持久化存储，确保离线开发与单元测试零外部依赖。

---

## 5. 验证与测试标准 (Verification Plan)

1. **静态类型与文档一致性检查**：
   * 更新 [`docs/007-architecture.md`](../007-architecture.md) 的 `## Modules` 与 `## Tests` 表；
   * 运行 `pnpm typecheck` 与 `pnpm test tests/docs.spec.ts`，确保零类型错误、零断链、模块表 100% 匹配。
2. **Telegram Source 单元测试 (`tests/telegram.spec.ts`)**：
   * 验证 `telegramTrigger` 对普通消息、回复链、按钮回调的幂等 ID 与 `ThreadRef` 映射，以及丢弃机器人自身消息；
   * 验证 `pollTelegram` 的游标（`KV.telegram.offset`）推进、单条损坏数据跳过、中断不丢游标、白名单用户触发 `explicit` 强度；
   * 验证 `sendTelegram` 的幂等参数传递、`410/403` 返回 `'gone'`、其余错误抛出触发 `Outbox` 退避重试；
   * 验证 `apply` 插件生命周期与健康状态上报（`setupPending`、`sourceOff`、`pollFailures`）。
3. **全量回归验证**：
   * 执行 `pnpm check`（依次通过 `pnpm typecheck && pnpm test && pnpm build`）。
