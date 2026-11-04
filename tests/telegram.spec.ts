import type { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import {
  TelegramItemSchema,
  apply as applyTelegram,
  pollTelegram,
  sendTelegram,
  telegramChannel,
  telegramKind,
  telegramLink,
  telegramTime,
  telegramTrigger,
  telegramTriggerId,
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
    expect(telegramKind.find!('check tgmsg_42 and tgmsg_42')).toEqual({ threads: [], terms: ['tgmsg_42'] })
    h.store.close()
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
    const run = (cli: string, args: string[]) => JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, AURA_DATA_DIR: dataDir },
        encoding: 'utf8',
      }),
    )

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

    // 3. gcal-cli L3 mutation blocked without --approved-by, succeeds with --approved-by
    expect(() => run(gcalPath, ['reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00']))
      .toThrow(/L3_APPROVAL_REQUIRED/)
    const rescheduled = run(gcalPath, [
      'reschedule', '--event-id', 'evt_3', '--start', '16:00', '--end', '17:00',
      '--approved-by', 'approve:reschedule_evt_3',
    ])
    expect(rescheduled).toMatchObject({ ok: true, tier: 'L3', event: { id: 'evt_3', start: '16:00', end: '17:00' } })
    expect(run(gcalPath, ['conflicts']).conflicts).toHaveLength(0)

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
    const sent = run(mailPath, [
      'send', '--draft-id', mailDraft.draft.id,
      '--approved-by', 'approve:send_mail_draft',
    ])
    expect(sent).toMatchObject({ ok: true, tier: 'L3', sent: { to: 'partner@tech-summit.example.org' } })
    expect(run(mailPath, ['unread']).count).toBe(1)
  })

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
})
