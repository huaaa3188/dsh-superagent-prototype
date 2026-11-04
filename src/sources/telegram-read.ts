/** Bounded Telegram thread context reader used by assessments to inspect messages around a trigger. */
import { z } from 'zod'
import { TelegramItemSchema, telegramTime } from './telegram-trigger.ts'
import type { ThreadContext } from './kind.ts'

const ThreadPageSchema = z.looseObject({
  items: z.array(TelegramItemSchema),
  next: z.string().optional(),
})

export const telegramThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, _part, cursor) => {
    const chatId = String(trigger.meta.chatId ?? '')
    const root = String(trigger.meta.rootId ?? trigger.meta.messageId ?? '')
    const output = await commands.run('tg-cli', [
      'thread',
      '--chat-id', chatId,
      '--root', root,
      '--json',
      ...(cursor ? ['--after', cursor] : []),
    ])
    const page = ThreadPageSchema.parse(JSON.parse(output))
    const messages = page.items.map(item => ({
      id: item.message_id,
      from: item.sender.name || item.sender.id,
      at: telegramTime(item.at),
      text: item.text,
      ...(item.sender.bot ? { bot: true as const } : {}),
      ...(item.reply_to_id ? { reply_to: item.reply_to_id } : {}),
      ...(item.url ? { url: item.url } : {}),
    }))
    return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
  },
}
