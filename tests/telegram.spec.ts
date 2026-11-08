import type { Context } from '@deepseek-ai/cordis'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import {
  TELEGRAM_MAX_BACKOFF_MS,
  TelegramItemSchema,
  apply as applyTelegram,
  pollTelegram,
  sendTelegram,
  telegramChannel,
  telegramKind,
  telegramLink,
  telegramPollDelay,
  telegramTime,
  telegramTrigger,
  telegramTriggerId,
  watchTelegram,
  type TelegramItem,
} from '../src/sources/telegram.ts'
import { testDeployment } from './fixtures/deployment.ts'

const ALLOWED_USER = '123456789'
const BOT_ID = '999888777'
const GROUP_CHAT = '-100112233'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function message(id: string, fields: Partial<TelegramItem> = {}): TelegramItem {
  return {
    id,
    message_id: id,
    chat_id: ALLOWED_USER,
    chat_type: 'private',
    sender: { id: ALLOWED_USER, name: 'Runhua', bot: false },
    mentions_me: false,
    text: `Hello from ${id}`,
    at: '2026-11-03T16:00:00.000Z',
    ...fields,
  }
}

function host(overrides: Partial<SourceContextDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-'))
  tempDirs.push(dir)
  const store = new Store(join(dir, 'db.sqlite'))
  const board = new HealthBoard()
  const sources = overrides.sources ?? new SourceRegistry(() => store.settings(), board)
  if (!overrides.sources) sources.register(telegramKind)
  store.saveSettings({
    ...SettingsSchema.parse({}),
    eval: { ...SettingsSchema.parse({}).eval, mode: 'auto' },
    sources: {
      telegram: {
        enabled: true,
        config: {
          chats: [{ chatId: GROUP_CHAT, name: 'Team Group', listen: 'mentions' }],
          directMessages: true,
          pollSeconds: 10,
        },
      },
    },
    policy: {
      ...SettingsSchema.parse({}).policy,
      sources: {
        telegram: {
          allowed: [{ id: ALLOWED_USER, name: 'Runhua' }],
          bots: [{ id: 'cron-bot', name: 'Daily Cron' }],
          admission: {},
        },
      },
    },
  })
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
  })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => {
    const result = engine.receive(trigger)
    engine.evaluateDue()
    return result
  })
  const deps: SourceContextDeps = {
    store,
    engine,
    outbox: { send: msg => { store.receipts.add(msg) } },
    commands,
    sources,
    deployment: testDeployment(),
    ready: Promise.resolve(),
    configured: () => true,
    receive,
    ...overrides,
  }
  return {
    ...deps,
    store,
    engine,
    commands,
    sources,
    receive,
    health: board.all,
    ctx: sourceContextOf(deps, telegramKind),
    context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind),
  }
}

function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

describe('Telegram Source', () => {
  it('translates messages, replies, and inline button callbacks into Triggers with stable IDs, and drops the bot\'s own messages', () => {
    expect(telegramTrigger(message('m0', { sender: { id: BOT_ID, bot: true } }), BOT_ID)).toBeUndefined()

    const dm = telegramTrigger(message('101'), BOT_ID)!
    expect(dm).toMatchObject({
      id: telegramTriggerId(ALLOWED_USER, '101'),
      source: 'telegram',
      threads: [{ source: 'telegram', id: `${ALLOWED_USER}:101` }],
      actor: { source: 'telegram', id: ALLOWED_USER },
      human: true,
      addressed: 'direct',
      text: 'Hello from 101',
    })

    const callback = telegramTrigger(message('cb_99', {
      message_id: '101',
      root_id: '101',
      reply_to_id: '101',
      text: 'ticket:t1:confirm_schedule',
    }), BOT_ID)!
    expect(callback.id).toBe(telegramTriggerId(ALLOWED_USER, 'cb_99'))
    expect(callback.threads).toEqual([{ source: 'telegram', id: `${ALLOWED_USER}:101` }])
    expect(telegramKind.repliesTo!(callback)).toBe(telegramTriggerId(ALLOWED_USER, '101'))

    expect(telegramTime('1762185600')).toBe('2025-11-03T16:00:00.000Z')
    expect(() => telegramTime('not-a-time')).toThrow('Unreadable Telegram message time')
  })

  it('polls updates after the cursor, stores valid Triggers once, filters unconfigured chats, and advances the cursor', async () => {
    const h = host()
    queue(h, () => ({
      me: BOT_ID,
      items: [
        message('m1'),
        { id: 'broken_item_missing_fields' },
        message('m2', { chat_id: '-100999999', chat_type: 'supergroup', mentions_me: true }),
        message('m3', { sender: { id: 'cron-bot', name: 'Cron', bot: true }, text: '[CRON:morning-briefing]' }),
      ],
      next: 42,
    }))

    expect(await pollTelegram(h.ctx, new AbortController().signal)).toEqual({ read: 4, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(await h.receive.mock.results[2]!.value).toBe('stored')
    expect(h.store.get(KV.telegram.offset)).toBe(42)

    // Allowed human sender in direct message produces an explicit candidate; listed cron-bot produces an inferred candidate.
    expect(h.engine.candidate(telegramTriggerId(ALLOWED_USER, 'm1'))?.strength).toBe('explicit')
    expect(h.engine.candidate(telegramTriggerId(ALLOWED_USER, 'm3'))?.strength).toBe('inferred')

    // Re-running with the same items is idempotent.
    await pollTelegram(h.ctx, new AbortController().signal)
    expect(await h.receive.mock.results[3]!.value).toBe('duplicate')
    h.store.close()
  })

  it('keeps its cursor unchanged when a poll round is cut short', async () => {
    const h = host()
    h.store.set(KV.telegram.offset, 7)
    const controller = new AbortController()
    h.receive.mockImplementationOnce(async () => {
      controller.abort()
      return 'stored'
    })
    queue(h, () => ({ me: BOT_ID, items: [message('m1'), message('m2')], next: 9 }))

    await expect(pollTelegram(h.ctx, controller.signal)).rejects.toThrow('stopped during the read')
    expect(h.store.get(KV.telegram.offset)).toBe(7)
    h.store.close()
  })

  it('sends replies idempotently, answers gone only for permanent rejections (410/403), and throws for transient errors', async () => {
    const h = host()
    const outbound: OutboundMessage = {
      id: 'out-1',
      channel: telegramChannel(ALLOWED_USER, '101', true, undefined, 'https://t.me/c/1/101'),
      text: 'Morning briefing ready.',
      kind: 'reply',
      ticketId: 't1',
    }
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue('{"ok":true}')
    expect(await sendTelegram(h.ctx, outbound)).toBe('sent')
    expect(run).toHaveBeenCalledWith('tg-cli', [
      'reply', '--chat-id', ALLOWED_USER, '--to', '101', '--key', 'out-1',
      '--kind', 'reply', '--markdown', 'Morning briefing ready.', '--ticket-id', 't1',
    ])

    run.mockRejectedValueOnce(commandError({ code: 1, stderr: '{"error":{"code":410,"message":"Chat gone"}}' }, 'tg-cli'))
    expect(await sendTelegram(h.ctx, outbound)).toBe('gone')

    run.mockRejectedValueOnce(commandError({ code: 1, stderr: '{"error":{"code":502,"message":"Bad Gateway"}}' }, 'tg-cli'))
    await expect(sendTelegram(h.ctx, outbound)).rejects.toThrow('Bad Gateway')

    expect(telegramLink(outbound.channel.address)).toEqual({
      url: 'https://t.me/c/1/101',
      label: { zh: 'Telegram 消息', en: 'Telegram message' },
      triggerId: telegramTriggerId(ALLOWED_USER, '101'),
    })
    // `tg-cli` never reports a link, so the Channel address alone must still produce a usable one.
    expect(telegramLink({ chatId: ALLOWED_USER, messageId: '101' }).url)
      .toBe(`tg://openmessage?user_id=${ALLOWED_USER}&message_id=101`)
    expect(telegramLink({ chatId: GROUP_CHAT, messageId: '55' }).url).toBe('https://t.me/c/100112233/55')
    expect(telegramLink({ chatId: GROUP_CHAT, messageId: '55', threadId: '9' }).url).toBe('https://t.me/c/100112233/55?thread=9')
    expect(telegramLink({ chatId: ALLOWED_USER }).url).toBe('')
    h.store.close()
  })

  it('reads Thread context pages and cursors through SourceRegistry.threadContext', async () => {
    const h = host()
    vi.spyOn(h.commands, 'run').mockResolvedValueOnce(JSON.stringify({
      items: [
        message('101', { text: 'Root request' }),
        message('102', { reply_to_id: '101', sender: { id: BOT_ID, name: 'Aura', bot: true }, text: 'On it.' }),
      ],
      next: '2',
    }))
    const trigger = telegramTrigger(message('101'), BOT_ID)!
    const context = h.sources.threadContext(trigger)!
    expect(context.messageId).toBe('101')
    const page = await context.read(h.commands, 'thread', '1')
    expect(page).toEqual({
      messages: [
        { id: '101', from: 'Runhua', at: '2026-11-03T16:00:00.000Z', text: 'Root request' },
        { id: '102', from: 'Aura', at: '2026-11-03T16:00:00.000Z', text: 'On it.', bot: true, reply_to: '101' },
      ],
      next: '2',
      body: {
        messages: [
          { id: '101', from: 'Runhua', at: '2026-11-03T16:00:00.000Z', text: 'Root request' },
          { id: '102', from: 'Aura', at: '2026-11-03T16:00:00.000Z', text: 'On it.', bot: true, reply_to: '101' },
        ],
      },
    })
    h.store.close()
  })

  it('validates Policy parts, generates admission rows, and exposes execution environment variables', () => {
    const h = host()
    expect(() => telegramKind.policy!.schema.parse({ allowed: [{ id: 'not_numeric' }] })).toThrow()
    expect(() => telegramKind.policy!.schema.parse({ allowed: [{ id: '1' }, { id: '1' }] })).toThrow('Duplicate user IDs')

    const rows = telegramKind.policy!.rows!({ chats: [{ chatId: GROUP_CHAT, name: 'Team Group', listen: 'all' }], directMessages: true })
    expect(rows).toEqual([
      {
        id: GROUP_CHAT,
        label: 'Team Group',
        note: { zh: '全部消息', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
      },
      {
        id: 'direct',
        label: { zh: '私聊', en: 'Direct messages' },
        note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
      },
    ])

    const trigger = telegramTrigger(message('101'), BOT_ID)!
    expect(telegramKind.environment!.values({ deployment: testDeployment(), config: telegramKind.schema.parse({}), trigger }))
      .toEqual({ DSH_SUPERAGENT_TELEGRAM_CHAT: ALLOWED_USER })
    h.store.close()
  })

  it('resolves Telegram message references into Thread keys and search terms', () => {
    // A supergroup link names the internal id behind the `-100` prefix, so the thread key is the real chat id.
    expect(telegramKind.find!('see https://t.me/c/112233/101 for details'))
      .toEqual({ threads: ['telegram:-100112233:101'], terms: ['101'] })
    // A public channel link carries a username rather than a chat id; the message id still searches exactly.
    expect(telegramKind.find!('https://t.me/aurabot/77')).toEqual({ threads: [], terms: ['77'] })
    // The private-chat deep link this Source writes links back to the conversation it came from.
    expect(telegramKind.find!(`tg://openmessage?user_id=${ALLOWED_USER}&message_id=101`))
      .toEqual({ threads: [`telegram:${ALLOWED_USER}:101`], terms: ['101'] })
    expect(telegramKind.find!('look at https://t.me/c/112233/42.')).toEqual({
      threads: ['telegram:-100112233:42'],
      terms: ['42'],
    })
    // `#42` is the GitHub numbering convention and names no Telegram message.
    expect(telegramKind.find!('#42')).toEqual({ threads: [], terms: [] })
    expect(telegramKind.find!('nothing to resolve here')).toEqual({ threads: [], terms: [] })
  })

  it('registers the kind on apply, reports setupPending while unconfigured, and unregisters cleanly on dispose', async () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const h = host({ sources, configured: () => false })
    const effects: (() => Promise<void> | void)[] = []
    const ctx = {
      orchestrator: h,
      effect: (fn: () => () => Promise<void> | void) => { effects.push(fn()) },
    } as unknown as Context

    applyTelegram(ctx)
    await vi.waitFor(() => expect(board.all.telegram).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(sources.kind('telegram')).toBe(telegramKind)

    for (const dispose of effects) await dispose()
    expect(sources.kind('telegram')).toBeUndefined()
    h.store.close()
  })

  it('executes scripts/aura-cli/tg-cli offline inbox commands (inject, pull, reply with idempotency + buttons, thread)', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'tg-cli-test-'))
    tempDirs.push(configDir)
    const cliPath = resolve(import.meta.dirname, '../scripts/aura-cli/tg-cli')
    const runCli = (args: string[]) => JSON.parse(
      execFileSync(process.execPath, [cliPath, ...args], {
        env: { ...process.env, TG_CLI_CONFIG_DIR: configDir },
        encoding: 'utf8',
      }),
    )

    const injected = runCli([
      'inject',
      '--chat-id', ALLOWED_USER,
      '--sender-id', ALLOWED_USER,
      '--sender-name', 'Runhua',
      '--text', 'Check my schedule today',
    ])
    expect(injected.ok).toBe(true)
    const msgId = String(injected.injected.message_id)

    const pulled = runCli(['pull', '--after', '0', '--json'])
    expect(pulled.items).toHaveLength(1)
    expect(pulled.items[0]).toMatchObject({
      chat_id: ALLOWED_USER,
      message_id: msgId,
      text: 'Check my schedule today',
    })
    expect(pulled.next).toBeGreaterThan(0)

    const reply1 = runCli([
      'reply',
      '--chat-id', ALLOWED_USER,
      '--to', msgId,
      '--key', 'outbox-msg-1',
      '--markdown', 'Confirm conflict?\n<!-- buttons: [{"label":"Keep A","data":"ticket:t1:keep_a"}] -->',
    ])
    expect(reply1).toMatchObject({ ok: true, message_id: expect.any(String) })
    expect(reply1.reused).toBeUndefined()

    // Duplicate --key returns reused: true without sending twice
    const reply2 = runCli([
      'reply',
      '--chat-id', ALLOWED_USER,
      '--to', msgId,
      '--key', 'outbox-msg-1',
      '--markdown', 'Confirm conflict?',
    ])
    expect(reply2).toMatchObject({ ok: true, reused: true, message_id: reply1.message_id })

    const thread = runCli(['thread', '--chat-id', ALLOWED_USER, '--root', msgId, '--json'])
    expect(thread.items).toHaveLength(2)
    expect(thread.items[1]).toMatchObject({
      reply_to_id: msgId,
      text: 'Confirm conflict?',
    })
  })

  it('enforces L1/L2/L3 permission tiers in gcal-cli and mail-cli, blocking unapproved L3 mutations', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aura-data-test-'))
    tempDirs.push(dataDir)
    const gcalPath = resolve(import.meta.dirname, '../scripts/aura-cli/gcal-cli')
    const mailPath = resolve(import.meta.dirname, '../scripts/aura-cli/mail-cli')
    const approvePath = resolve(import.meta.dirname, '../scripts/aura-cli/aura-approve')
    const approvalEnv = { AURA_DATA_DIR: dataDir, AURA_APPROVAL_KEY_FILE: join(dataDir, 'approval.key') }
    const run = (cli: string, args: string[]) => JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, ...approvalEnv },
        encoding: 'utf8',
      }),
    )
    // L3 operations need a token minted by the Host-side tool; a free-form string must not pass.
    run(approvePath, ['keygen'])
    const approve = (action: string, target: string) => run(
      approvePath,
      ['issue', '--action', action, '--target', target],
    ).token as string

    // 1. gcal-cli L1 read + conflict detection
    const listed = run(gcalPath, ['list'])
    expect(listed.events.length).toBeGreaterThanOrEqual(3)
    expect(listed.conflicts).toHaveLength(1)
    expect(listed.conflicts[0].overlapMinutes).toBe(30)

    // 2. gcal-cli L2 draft creation + GTD management
    const draftEvt = run(gcalPath, ['draft-add', '--title', '1-on-1 Sync', '--start', '17:00', '--end', '17:30'])
    expect(draftEvt).toMatchObject({ ok: true, tier: 'L2', draft: { title: '1-on-1 Sync', status: 'draft' } })
    const gtdAdded = run(gcalPath, ['gtd-add', '--title', 'Prepare slides', '--priority', 'high'])
    expect(gtdAdded).toMatchObject({ ok: true, tier: 'L2', todo: { title: 'Prepare slides', status: 'todo' } })
    const gtdDone = run(gcalPath, ['gtd-done', '--id', gtdAdded.todo.id])
    expect(gtdDone).toMatchObject({ ok: true, tier: 'L2', todo: { status: 'done' } })

    // 3. gcal-cli L3 mutation blocked without a token, and a forged string is rejected outright
    expect(() => run(gcalPath, ['reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00']))
      .toThrow(/L3_APPROVAL_REQUIRED/)
    expect(() => run(gcalPath, [
      'reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00',
      '--approved-by', 'approve:reschedule_evt_3',
    ])).toThrow(/L3_APPROVAL_INVALID/)
    // A token is bound to its target: approving a different slot must not authorize this one.
    expect(() => run(gcalPath, [
      'reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00',
      '--approved-by', approve('gcal.reschedule', 'evt_3 09:00-10:00'),
    ])).toThrow(/L3_APPROVAL_MISMATCH/)

    const rescheduleToken = approve('gcal.reschedule', 'evt_3 16:00-17:00')
    const rescheduled = run(gcalPath, [
      'reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00',
      '--approved-by', rescheduleToken,
    ])
    expect(rescheduled).toMatchObject({ ok: true, tier: 'L3', event: { id: 'evt_3', start: '16:00', end: '17:00' } })
    // The audit value is the spent nonce, so a log line proves which approval was consumed.
    expect(rescheduled.approvedBy).toMatch(/^gcal\.reschedule:[0-9a-f]{24}$/)
    expect(run(gcalPath, ['conflicts']).conflicts).toHaveLength(0)

    // A spent token stays spent: replaying the same string must not reschedule anything again.
    expect(() => run(gcalPath, [
      'reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00',
      '--approved-by', rescheduleToken,
    ])).toThrow(/L3_APPROVAL_REUSED/)

    // 4. mail-cli L1 unread + L2 draft + L3 send gate
    const unread = run(mailPath, ['unread'])
    expect(unread.count).toBe(2)
    const mailDraft = run(mailPath, [
      'draft',
      '--to', 'partner@tech-summit.example.org',
      '--subject', 'Re: 周三下午合作伙伴周会确认',
      '--body', '已顺延至 16:00-17:00，届时见！',
      '--reply-to', 'mail_102',
    ])
    expect(mailDraft).toMatchObject({ ok: true, tier: 'L2' })

    expect(() => run(mailPath, ['send', '--draft-id', mailDraft.draft.id]))
      .toThrow(/L3_APPROVAL_REQUIRED/)
    expect(() => run(mailPath, [
      'send', '--draft-id', mailDraft.draft.id,
      '--approved-by', 'approve:send_mail_draft',
    ])).toThrow(/L3_APPROVAL_INVALID/)
    const sent = run(mailPath, [
      'send', '--draft-id', mailDraft.draft.id,
      '--approved-by', approve('mail.send', mailDraft.draft.id),
    ])
    expect(sent).toMatchObject({ ok: true, tier: 'L3', sent: { to: 'partner@tech-summit.example.org' } })
    expect(run(mailPath, ['unread']).count).toBe(1)
  })

  it('never lets an injected event be overtaken by the live update_id cursor, and never advances the live cursor itself', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'tg-cli-cursor-test-'))
    tempDirs.push(configDir)
    const cliPath = resolve(import.meta.dirname, '../scripts/aura-cli/tg-cli')
    const runCli = (args: string[]) => JSON.parse(
      execFileSync(process.execPath, [cliPath, ...args], {
        env: { ...process.env, TG_CLI_CONFIG_DIR: configDir },
        encoding: 'utf8',
      }),
    )
    const stateFile = join(configDir, 'state.json')

    // A live poll has already advanced the plugin's cursor past every plausible injected id.
    writeFileSync(stateFile, JSON.stringify({
      nextUpdateId: 50005,
      sentKeys: {},
      injected: [],
      threads: {},
      messageRoots: {},
    }))

    const injected = runCli([
      'inject',
      '--chat-id', ALLOWED_USER,
      '--sender-id', 'cron-bot',
      '--text', 'Morning briefing',
    ])
    expect(injected.ok).toBe(true)
    // The injected id must sit above the injected base, not at the live cursor.
    expect(injected.injected.update_id).toBeGreaterThanOrEqual(1_000_000_000_000)

    // Injecting must not touch the live cursor: a huge `getUpdates` offset makes Telegram skip real updates.
    const afterInject = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(afterInject.nextUpdateId).toBe(50005)

    // Regression: a plugin sitting at cursor 50005 used to see an empty pull and lose the briefing silently.
    const pulled = runCli(['pull', '--after', '50005', '--json'])
    expect(pulled.items).toHaveLength(1)
    expect(pulled.items[0]).toMatchObject({ text: 'Morning briefing', sender: { id: 'cron-bot' } })
    expect(pulled.next).toBeGreaterThanOrEqual(1_000_000_000_000)

    // The cursor returned above must not re-deliver the same event.
    const again = runCli(['pull', '--after', String(pulled.next), '--json'])
    expect(again.items).toHaveLength(0)
    expect(again.next).toBe(pulled.next)

    // And the live cursor still stands where the last real poll left it.
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).nextUpdateId).toBe(50005)
  })

  it('keeps an event injected during a live getUpdates wait instead of overwriting it with the poller snapshot', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'tg-cli-race-test-'))
    tempDirs.push(configDir)
    const cliPath = resolve(import.meta.dirname, '../scripts/aura-cli/tg-cli')

    // A local stand-in for the Bot API holds `getUpdates` open, so the cron timer can fire inside the poll window.
    let releasePoll: () => void = () => {}
    const pollGate = new Promise<void>(resolvePoll => { releasePoll = resolvePoll })
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        if (req.url?.endsWith('/getUpdates')) {
          await pollGate
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result: [] }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: true }))
      })
    })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = (server.address() as net.AddressInfo).port

    const env = {
      ...process.env,
      TG_CLI_CONFIG_DIR: configDir,
      TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      botToken: '000000:race-test-token',
      botId: BOT_ID,
      botUsername: 'aura_bot',
    }))
    writeFileSync(join(configDir, 'state.json'), JSON.stringify({
      nextUpdateId: 700,
      sentKeys: {},
      injected: [],
      threads: {},
      messageRoots: {},
    }))

    let pulled = ''
    try {
      // `pull` reads state at startup, blocks on the network, then re-reads state before writing. Injecting inside that
      // window models the cron timer firing mid-poll.
      const pulling = execFileAsync(process.execPath, [cliPath, 'pull', '--after', '0', '--json', '--timeout', '1'], { env })
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
      execFileSync(process.execPath, [
        cliPath, 'inject',
        '--chat-id', ALLOWED_USER,
        '--sender-id', 'cron-bot',
        '--text', 'Injected mid-poll',
      ], { env, encoding: 'utf8' })
      releasePoll()
      pulled = (await pulling).stdout
    } finally {
      releasePoll()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    }

    // The stale pre-poll snapshot used to be written back here, so the injection vanished without an error: the pull
    // returned nothing and the event was gone for good.
    const result = JSON.parse(pulled)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ text: 'Injected mid-poll', sender: { id: 'cron-bot' } })
    expect(result.next).toBeGreaterThanOrEqual(1_000_000_000_000)

    const state = JSON.parse(readFileSync(join(configDir, 'state.json'), 'utf8'))
    // Delivered, and therefore drained exactly once.
    expect(state.injected).toHaveLength(0)
    // Nor may the poll's state write roll the live cursor backwards.
    expect(state.nextUpdateId).toBe(700)
  }, 20_000)

  it('supports Phase 3 proactive cron triggers (aura-cron) and L3 cold archive indexing/search (aura-kb)', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'aura-cron-test-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'aura-kb-test-'))
    tempDirs.push(configDir, dataDir)
    const cronPath = resolve(import.meta.dirname, '../scripts/aura-cli/aura-cron')
    const tgPath = resolve(import.meta.dirname, '../scripts/aura-cli/tg-cli')
    const kbPath = resolve(import.meta.dirname, '../scripts/aura-cli/aura-kb')

    const runEnv = {
      ...process.env,
      TG_CLI_CONFIG_DIR: configDir,
      ORCHESTRATOR_DATA_DIR: dataDir,
    }
    const run = (cli: string, args: string[]) => JSON.parse(
      execFileSync(process.execPath, [cli, ...args], { env: runEnv, encoding: 'utf8' }),
    )

    // 1. aura-cron morning-briefing injects a bot trigger (`cron-bot`) into tg-cli
    const injected = run(cronPath, ['morning-briefing', '--chat-id', ALLOWED_USER, '--cli', tgPath])
    expect(injected.ok).toBe(true)
    expect(injected.injected).toMatchObject({
      chat_id: ALLOWED_USER,
      sender: { id: 'cron-bot', name: 'Daily Scheduler', bot: true },
    })
    expect(injected.injected.text).toContain('[CRON:morning-briefing]')

    // The printed crontab must restart only when `status` exits 1, so `||` here would fire on every run.
    const crontab = String(run(cronPath, ['print-crontab', '--chat-id', ALLOWED_USER, '--repo-dir', '/srv/dsh-superagent']).crontab)
    const lines = crontab.split('\n')
    const check = lines.find(line => line.includes('--profile superagent status'))!
    expect(check).toMatch(/^0 \* \* \* \* /)
    expect(check).toContain('status >/dev/null 2>&1; [ $? -eq 1 ] && ')
    expect(check).not.toContain('|| [ $?')
    expect(check).toContain('--respect-stop restart')
    const path = lines.find(line => line.startsWith('PATH='))!.slice('PATH='.length).split(':')
    expect(path).toContain(join(homedir(), '.local', 'bin'))
    expect(path).toContain(dirname(process.execPath))
    // Every entry must exist: a fixed platform path such as /opt/homebrew/bin would not on Linux.
    for (const dir of path) expect(existsSync(dir)).toBe(true)

    const pulled = run(tgPath, ['pull', '--after', '0', '--json'])
    expect(pulled.items).toHaveLength(1)
    const trigger = telegramTrigger(TelegramItemSchema.parse(pulled.items[0]), BOT_ID)!
    expect(trigger).toMatchObject({
      actor: { source: 'telegram', id: 'cron-bot' },
      human: false,
      addressed: 'direct',
    })

    // 2. aura-kb saves a long-form report to L3 knowledge/reports, updates INDEX.md, and supports search & read
    const saved = run(kbPath, [
      'save',
      '--category', 'reports',
      '--slug', 'multi-agent-memory-survey',
      '--title', '2026 多智能体长期记忆架构调研报告',
      '--summary', '对比 L1/L2/L3 分层记忆与纯向量检索在个人伴侣场景下的召回精度与注意力开销。',
      '--tags', 'memory,research,l3',
      '--content', '# 2026 多智能体长期记忆架构调研报告\n\n核心结论：结构化 Markdown 归档配合按需检索显著优于全量塞入上下文。',
    ])
    expect(saved).toMatchObject({
      ok: true,
      tier: 'L2',
      entry: {
        category: 'reports',
        slug: 'multi-agent-memory-survey',
        title: '2026 多智能体长期记忆架构调研报告',
      },
    })

    const searchRes = run(kbPath, ['search', '--query', '结构化 Markdown'])
    expect(searchRes.count).toBe(1)
    expect(searchRes.results[0].slug).toBe('multi-agent-memory-survey')

    const readRes = run(kbPath, ['read', '--path', saved.entry.relPath])
    expect(readRes.content).toContain('核心结论：结构化 Markdown 归档')
  })

  it('computes exponential backoff in telegramPollDelay and reports pollFailures after 3 consecutive errors in watchTelegram', async () => {
    expect(telegramPollDelay(5, 0)).toBe(5_000)
    expect(telegramPollDelay(5, 1)).toBe(10_000)
    expect(telegramPollDelay(5, 2)).toBe(20_000)
    expect(telegramPollDelay(5, 3)).toBe(40_000)
    expect(telegramPollDelay(10, 10)).toBe(TELEGRAM_MAX_BACKOFF_MS)

    const h = host()
    const controller = new AbortController()
    let callCount = 0
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'run').mockImplementation(async () => {
      callCount += 1
      if (callCount <= 3) {
        throw new Error(`Telegram poll timeout #${callCount}`)
      }
      controller.abort()
      return JSON.stringify({ me: BOT_ID, items: [], next: 1 })
    })
    // Speed up pollSeconds to minimum and abort on 4th call
    vi.spyOn(h.ctx, 'config').mockReturnValue({ chats: [], directMessages: true, pollSeconds: 0.005 as unknown as number })

    const watching = watchTelegram(h.ctx, controller.signal)
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(3), { timeout: 2000 })
    expect(h.health.telegram).toMatchObject({ state: 'error', code: 'pollFailures' })
    controller.abort()
    await watching
    h.store.close()
  })

  it('connects gcal-cli to a real Google Calendar REST v3 endpoint with OAuth2 token refresh and 503 network jitter retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aura-gcal-api-'))
    tempDirs.push(dataDir)
    const gcalPath = resolve(import.meta.dirname, '../scripts/aura-cli/gcal-cli')
    const approvePath = resolve(import.meta.dirname, '../scripts/aura-cli/aura-approve')
    const approvalEnv = {
      AURA_DATA_DIR: dataDir,
      AURA_APPROVAL_KEY_FILE: join(dataDir, 'approval.key'),
    }
    const runApprove = (args: string[]) => JSON.parse(
      execFileSync(process.execPath, [approvePath, ...args], {
        env: { ...process.env, ...approvalEnv },
        encoding: 'utf8',
      }),
    )
    runApprove(['keygen'])

    let listAttempts = 0
    const remoteEvents = [
      {
        id: 'gcal_remote_1',
        summary: 'Google Calendar 云端架构会',
        location: 'Google Meet',
        status: 'confirmed',
        start: { dateTime: '2026-11-07T10:00:00+08:00' },
        end: { dateTime: '2026-11-07T11:30:00+08:00' },
      },
      {
        id: 'gcal_remote_2',
        summary: '云端冲突会议',
        location: 'Zoom',
        status: 'confirmed',
        start: { dateTime: '2026-11-07T11:00:00+08:00' },
        end: { dateTime: '2026-11-07T12:00:00+08:00' },
      },
    ]

    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        if (req.url === '/token' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ access_token: 'mock_oauth_access_token', expires_in: 3600 }))
          return
        }
        if (req.url?.startsWith('/calendar/v3/calendars/primary/events') && req.method === 'GET') {
          listAttempts += 1
          if (listAttempts === 1) {
            // Simulate transient 503 network jitter on first attempt
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Backend transient error' } }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ items: remoteEvents }))
          return
        }
        if (req.url === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
          const parsed = JSON.parse(body)
          const created = {
            id: 'gcal_created_99',
            summary: parsed.summary,
            location: parsed.location,
            status: 'confirmed',
            start: parsed.start,
            end: parsed.end,
          }
          remoteEvents.push(created)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(created))
          return
        }
        res.writeHead(404).end()
      })
    })

    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
    const port = (server.address() as net.AddressInfo).port
    const configFile = join(dataDir, 'gcal-config.json')
    writeFileSync(configFile, JSON.stringify({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token',
      calendarId: 'primary',
      apiBase: `http://127.0.0.1:${port}/calendar/v3`,
      tokenEndpoint: `http://127.0.0.1:${port}/token`,
    }))

    const runGcal = async (args: string[]) => {
      const { stdout } = await execFileAsync(process.execPath, [gcalPath, ...args], {
        env: { ...process.env, ...approvalEnv, AURA_GCAL_CONFIG: configFile },
        encoding: 'utf8',
      })
      return JSON.parse(stdout)
    }

    try {
      const listed = await runGcal(['list', '--date', '2026-11-07'])
      expect(listAttempts).toBe(2) // Proves 503 retry succeeded
      expect(listed.provider).toBe('google-calendar')
      expect(listed.events).toHaveLength(2)
      expect(listed.conflicts).toHaveLength(1)
      expect(listed.conflicts[0].overlapMinutes).toBe(30)

      const draft = await runGcal(['draft-add', '--date', '2026-11-07', '--title', '新增云端日程', '--start', '15:00', '--end', '16:00'])
      const commitToken = runApprove(['issue', '--action', 'gcal.commit-draft', '--target', draft.draft.id]).token as string
      const committed = await runGcal(['commit-draft', '--draft-id', draft.draft.id, '--approved-by', commitToken])
      expect(committed).toMatchObject({
        ok: true,
        tier: 'L3',
        provider: 'google-calendar',
        event: { id: 'gcal_created_99', title: '新增云端日程' },
      })
    } finally {
      server.close()
    }
  })

  it('connects mail-cli to real IMAP4rev1 and SMTP servers with MIME UTF-8 decoding and L3 approval', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aura-mail-api-'))
    tempDirs.push(dataDir)
    const mailPath = resolve(import.meta.dirname, '../scripts/aura-cli/mail-cli')
    const approvePath = resolve(import.meta.dirname, '../scripts/aura-cli/aura-approve')
    const approvalEnv = {
      AURA_DATA_DIR: dataDir,
      AURA_APPROVAL_KEY_FILE: join(dataDir, 'approval.key'),
    }
    const runApprove = (args: string[]) => JSON.parse(
      execFileSync(process.execPath, [approvePath, ...args], {
        env: { ...process.env, ...approvalEnv },
        encoding: 'utf8',
      }),
    )
    runApprove(['keygen'])

    const smtpReceived: string[] = []

    // Minimal mock IMAP4rev1 server
    const imapServer = net.createServer(socket => {
      socket.write('* OK IMAP4rev1 Mock Ready\r\n')
      let buf = ''
      socket.on('data', chunk => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\r\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const [tag, cmd, ...rest] = line.split(' ')
          const argStr = rest.join(' ')
          if (cmd === 'LOGIN') {
            socket.write(`${tag} OK LOGIN completed\r\n`)
          } else if (cmd === 'SELECT') {
            socket.write(`* 1 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`)
          } else if (cmd === 'UID' && argStr.startsWith('SEARCH UNSEEN')) {
            socket.write(`* SEARCH 501\r\n${tag} OK UID SEARCH completed\r\n`)
          } else if (cmd === 'UID' && argStr.startsWith('FETCH 501')) {
            const subjB64 = Buffer.from('[重要] 真实 IMAP 账单通知', 'utf8').toString('base64')
            socket.write(
              `* 1 FETCH (UID 501 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {120}\r\n` +
              `From: billing@real-imap.example.com\r\n` +
              `Subject: =?UTF-8?B?${subjB64}?=\r\n` +
              `Date: Sat, 07 Nov 2026 08:00:00 +0800\r\n\r\n` +
              `请尽快核对本月账单明细。)\r\n` +
              `${tag} OK UID FETCH completed\r\n`,
            )
          } else if (cmd === 'LOGOUT') {
            socket.write(`* BYE IMAP4rev1 logging out\r\n${tag} OK LOGOUT completed\r\n`)
          }
        }
      })
    })

    // Minimal mock SMTP server
    const smtpServer = net.createServer(socket => {
      socket.write('220 smtp.example.com ESMTP ready\r\n')
      let inData = false
      let dataBuf = ''
      let buf = ''
      socket.on('data', chunk => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\r\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (inData) {
            if (line === '.') {
              inData = false
              smtpReceived.push(dataBuf)
              socket.write('250 2.0.0 OK queued\r\n')
            } else {
              dataBuf += line + '\n'
            }
            continue
          }
          if (/^EHLO/i.test(line)) socket.write('250-smtp.example.com\r\n250 AUTH PLAIN LOGIN\r\n')
          else if (/^AUTH PLAIN/i.test(line)) socket.write('235 2.7.0 Authentication successful\r\n')
          else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 Originator OK\r\n')
          else if (/^RCPT TO/i.test(line)) socket.write('250 2.1.5 Recipient OK\r\n')
          else if (/^DATA/i.test(line)) {
            inData = true
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          } else if (/^QUIT/i.test(line)) {
            socket.write('221 2.0.0 Bye\r\n')
          }
        }
      })
    })

    await new Promise<void>(r => imapServer.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>(r => smtpServer.listen(0, '127.0.0.1', () => r()))
    const imapPort = (imapServer.address() as net.AddressInfo).port
    const smtpPort = (smtpServer.address() as net.AddressInfo).port

    const mailCfgPath = join(dataDir, 'mail-config.json')
    writeFileSync(mailCfgPath, JSON.stringify({
      imap: { host: '127.0.0.1', port: imapPort, tls: false, user: 'aura@example.com', pass: 'secret' },
      smtp: { host: '127.0.0.1', port: smtpPort, tls: false, user: 'aura@example.com', pass: 'secret', from: 'aura@example.com' },
    }))

    const runMail = async (args: string[]) => {
      const { stdout } = await execFileAsync(process.execPath, [mailPath, ...args], {
        env: { ...process.env, ...approvalEnv, AURA_MAIL_CONFIG: mailCfgPath },
        encoding: 'utf8',
      })
      return JSON.parse(stdout)
    }

    try {
      const unread = await runMail(['unread'])
      expect(unread.provider).toBe('imap')
      expect(unread.count).toBe(1)
      expect(unread.items[0]).toMatchObject({
        id: 'imap_501',
        from: 'billing@real-imap.example.com',
        subject: '[重要] 真实 IMAP 账单通知',
        priority: 'high',
      })

      const draft = await runMail([
        'draft',
        '--to', 'billing@real-imap.example.com',
        '--subject', 'Re: 真实 IMAP 账单通知',
        '--body', '已确认账单无误，请按期扣款。',
      ])
      const sendToken = runApprove(['issue', '--action', 'mail.send', '--target', draft.draft.id]).token as string
      const sent = await runMail([
        'send',
        '--draft-id', draft.draft.id,
        '--approved-by', sendToken,
      ])
      expect(sent).toMatchObject({
        ok: true,
        tier: 'L3',
        provider: 'smtp',
      })
      expect(smtpReceived).toHaveLength(1)
      expect(smtpReceived[0]).toContain('To: billing@real-imap.example.com')
    } finally {
      imapServer.close()
      smtpServer.close()
    }
  })
})
