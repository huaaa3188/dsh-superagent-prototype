/** Telegram source kind definition, policy integration, and Cordis polling loop. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { sendTelegram, telegramLink } from './telegram-channel.ts'
import { telegramThreadContext } from './telegram-read.ts'
import { SOURCE, TelegramItemSchema, telegramFind, telegramTrigger, telegramTriggerId } from './telegram-trigger.ts'

export { SOURCE, TelegramItemSchema, telegramChannel, telegramFind, telegramThreadId, telegramTime, telegramTrigger, telegramTriggerId }
  from './telegram-trigger.ts'
export type { TelegramItem } from './telegram-trigger.ts'
export { sendTelegram, telegramLink } from './telegram-channel.ts'
export { telegramThreadContext } from './telegram-read.ts'

const PullPageSchema = z.looseObject({
  me: z.string().min(1),
  items: z.array(z.unknown()).default([]),
  next: z.number().int(),
})

export const TelegramConfigSchema = z.object({
  chats: z.array(z.object({
    chatId: z.string().regex(/^-?[0-9]+$/),
    name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']),
  }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  pollSeconds: z.number().int().min(2).max(3600).default(10),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: {
    zh: '接收 Telegram 私聊、指定群组的消息与内联按钮回调。',
    en: 'Receives messages and inline button callbacks from Telegram direct messages and configured chats.',
  },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'chats', type: 'rows', label: { zh: '接收的群组', en: 'Chats' },
      hint: {
        zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。',
        en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.',
      },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群 ID', en: 'Chat ID' }, pattern: '-?[0-9]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
          { value: 'all', label: { zh: '全部消息', en: 'All' } },
        ] },
      ] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['telegram'],
  scope({ meta }, config) {
    if (meta.direct === true) {
      return config.directMessages
        ? { listened: true, observed: false, row: 'direct' }
        : { listened: false, reason: 'direct_messages_not_allowed' }
    }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    allowed: (address, config) =>
      telegramKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendTelegram,
    link: telegramLink,
  },
  threadContext: telegramThreadContext,
  find: query => telegramFind(query),
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
      }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs')
        .default([]),
      bots: z.array(z.object({
        id: z.string().min(1),
        name: z.string().trim().max(100).optional(),
      }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot IDs')
        .optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Telegram 用户', en: 'Telegram users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'User ID', en: 'User ID' }, pattern: '[0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: {
          zh: '名单里的机器人（或定时触发器如 cron-bot）发来的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。',
          en: 'Messages of a bot on this list become inferred candidates for an assessment; they never make an explicit request or stop a ticket.',
        },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'Bot ID', en: 'Bot ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: {
      zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。',
      en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.',
    },
    rows(stored) {
      const config = TelegramConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({
          id: chat.chatId,
          label: chat.name || chat.chatId,
          note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' },
        })),
        {
          id: 'direct',
          label: { zh: '私聊', en: 'Direct messages' },
          note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false },
        },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: {
        zh: '接下工单的 Telegram chat_id；工单不是从 Telegram 来的时为空',
        en: 'chat_id of the Telegram chat that started the ticket; empty when the ticket did not start on Telegram',
      } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
    }),
  },
}

/** Reads the Telegram update queue after the cursor, stores each valid Trigger, and advances the cursor past them. */
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

export const TELEGRAM_MAX_BACKOFF_MS = 300_000

/** Computes the wait duration before the next Telegram poll, applying exponential backoff on consecutive failures. */
export function telegramPollDelay(pollSeconds: number, failures: number): number {
  const baseMs = (pollSeconds > 0 ? pollSeconds : 10) * 1000
  if (failures <= 0) return baseMs
  return Math.min(TELEGRAM_MAX_BACKOFF_MS, baseMs * (2 ** Math.min(failures, 6)))
}

export async function watchTelegram(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('telegram', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>(SOURCE)
    if (!config) {
      failures = 0
      ctx.report('telegram', health('paused', 'sourceOff'))
    } else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollTelegram(ctx, signal)
        failures = 0
        ctx.report('telegram', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) {
          ctx.report('telegram', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay(telegramPollDelay(config?.pollSeconds ?? 10, failures), undefined, { signal }).catch(() => {})
  }
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
