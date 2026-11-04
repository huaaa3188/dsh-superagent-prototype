/** Normalizes Telegram Bot updates (messages, replies, and inline button callbacks) into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'telegram'

/** One update item as `tg-cli pull` and `tg-cli thread` print it. */
export const TelegramItemSchema = z.looseObject({
  id: z.string().min(1),
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
  url: z.string().optional(),
})
export type TelegramItem = z.infer<typeof TelegramItemSchema>

/** Deterministic trigger ID for a Telegram event; every read path for this event produces the same ID. */
export const telegramTriggerId = (chatId: string, eventId: string): string =>
  key(SOURCE, `${chatId}:${eventId}`)

/** Thread ID grouping a root message, its reply chain, its forum topic, and inline button callbacks on it. */
export const telegramThreadId = (chatId: string, rootId: string | undefined, messageId: string): string =>
  `${chatId}:${rootId ?? messageId}`

/** Constructs a Telegram reply channel address; records `direct` explicitly so `allowed` can check configuration without network reads. */
export const telegramChannel = (chatId: string, messageId: string, direct = false, threadId?: string, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${chatId}`,
  address: {
    chatId,
    messageId,
    ...(direct ? { direct: 'true' } : {}),
    ...(threadId ? { threadId } : {}),
    ...(url ? { url } : {}),
  },
})

/** Parses a Telegram timestamp (ISO-8601 string or epoch seconds/milliseconds string) into a canonical ISO-8601 string. */
export function telegramTime(value: string): string {
  const numeric = /^\d+$/.test(value) ? Number(value) : NaN
  const millis = Number.isFinite(numeric) ? (value.length <= 10 ? numeric * 1000 : numeric) : Date.parse(value)
  if (!Number.isFinite(millis)) throw new Error(`Unreadable Telegram message time: ${value}`)
  return new Date(millis).toISOString()
}

/** Converts one validated Telegram update item into a Trigger, returning undefined for messages sent by the bot itself. */
export function telegramTrigger(item: TelegramItem, botId: string): Trigger | undefined {
  if (item.sender.id === botId) return undefined
  const direct = item.chat_type === 'private'
  const root = item.root_id ?? item.thread_id ?? item.message_id
  const thread = telegramThreadId(item.chat_id, root, item.message_id)
  return {
    id: telegramTriggerId(item.chat_id, item.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: item.sender.id },
    human: !item.sender.bot,
    ...(direct ? { addressed: 'direct' as const } : item.mentions_me ? { addressed: 'mention' as const } : {}),
    at: telegramTime(item.at),
    text: item.text,
    channel: telegramChannel(item.chat_id, item.message_id, direct, item.thread_id, item.url),
    ...(item.url ? { url: item.url } : {}),
    meta: {
      chatId: item.chat_id,
      messageId: item.message_id,
      eventId: item.id,
      rootId: root,
      direct,
      mentioned: item.mentions_me,
      ...(item.reply_to_id ? { parentId: item.reply_to_id } : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(item.sender.name ? { senderName: item.sender.name } : {}),
    },
  }
}
