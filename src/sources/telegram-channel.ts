/** Telegram outbound channel: sends idempotent threaded replies and inline approval keyboards through tg-cli. */
import { latestAssignment, type OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { wordCount } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

const TELEGRAM_MAX_WORDS = 300
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
  const count = wordCount(visibleText)
  if (count > TELEGRAM_MAX_WORDS) {
    throw new Error(`Telegram message has ${count} words; maximum is ${TELEGRAM_MAX_WORDS}. Rewrite as a concise card.`)
  }
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

/** Constructs the panel display link for a Telegram Channel address. */
export const telegramLink = (address: Record<string, string>): ChannelLink => ({
  url: address.url ?? '',
  label: { zh: 'Telegram 消息', en: 'Telegram message' },
  ...(address.chatId && address.messageId ? { triggerId: telegramTriggerId(address.chatId, address.messageId) } : {}),
})
