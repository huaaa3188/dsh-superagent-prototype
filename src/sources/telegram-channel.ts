/** Telegram outbound channel: sends idempotent threaded replies and inline approval keyboards through tg-cli. */
import { latestAssignment, type OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

const BUTTONS_RE = /<!--\s*buttons:\s*\[[\s\S]*?\]\s*-->/

/**
 * True when Telegram permanently rejects a reply because the chat was deleted, the user deactivated, or the bot was blocked.
 * Transient network or 5xx errors return false so Outbox retries with exponential backoff.
 */
const gone = (error: unknown): boolean =>
  error instanceof CliError && error.code !== undefined && (
    error.code === 410
    || error.code === 403
    || (error.code === 400 && /chat not found|user is deactivated|message thread not found/i.test(error.message))
  )

/** Sends a reply under the target Telegram message idempotently by `message.id`. */
export async function sendTelegram(
  host: Pick<SourceContext, 'commands'> & Partial<Pick<SourceContext, 'tickets'>>,
  message: OutboundMessage,
): Promise<'sent' | 'gone'> {
  const { chatId, messageId, threadId } = message.channel.address
  if (!chatId || !messageId) throw new Error('Missing Telegram reply target')
  const visibleText = message.text.replace(/<!--\s*buttons:\s*\[[\s\S]*?\]\s*-->/g, '').trim() || message.text
  checkedImText(visibleText)
  let text = message.text
  if (message.kind === 'reply' && !BUTTONS_RE.test(text) && message.ticketId && host.tickets) {
    const ticket = host.tickets.get(message.ticketId)
    const fallbackSource = ticket?.attention?.question ?? (ticket ? latestAssignment(ticket)?.report?.summary : undefined) ?? ''
    const match = fallbackSource.match(BUTTONS_RE)
    if (match) text = `${text}\n${match[0]}`
  }
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
    await host.commands.run('tg-cli', args)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

/**
 * Best-effort message link for a Telegram Channel address.
 * `tg-cli` does not report a link for every update, so synthesize one: private chats deep-link through the `tg://`
 * scheme, groups and supergroups through their `t.me/c/<chat>/<message>` form.
 */
const telegramUrl = (address: Record<string, string>): string => {
  if (address.url) return address.url
  const { chatId, messageId } = address
  if (!chatId || !messageId) return ''
  const topic = address.threadId ? `?thread=${address.threadId}` : ''
  if (chatId.startsWith('-')) return `https://t.me/c/${chatId.slice(1)}/${messageId}${topic}`
  return `tg://openmessage?user_id=${chatId}&message_id=${messageId}`
}

/** Constructs the panel display link for a Telegram Channel address. */
export const telegramLink = (address: Record<string, string>): ChannelLink => ({
  url: telegramUrl(address),
  label: { zh: 'Telegram 消息', en: 'Telegram message' },
  ...(address.chatId && address.messageId ? { triggerId: telegramTriggerId(address.chatId, address.messageId) } : {}),
})
