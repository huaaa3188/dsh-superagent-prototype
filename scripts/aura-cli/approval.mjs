/**
 * approval.mjs: single-use, action-bound approval tokens for L3 CLI operations.
 *
 * A token authorizes exactly one (action, target) pair, once, until it expires. It is an
 * HMAC-SHA256 over a canonical payload, so a caller cannot widen the action, retarget it,
 * extend it, or reuse it by editing the string.
 *
 * The token is only as strong as the secrecy of the key. `aura-approve` (which mints) must
 * run with the key available; the acting CLI only needs to verify, and both read the same
 * key file. Workers run as the operator's OS user, so a worker that deliberately reads the
 * key file can still mint a token: this raises the bar from "any non-empty string" to
 * "a value only the Host could have produced", and turns every L3 operation into an
 * auditable, non-replayable event. Real enforcement needs the worker under a separate OS
 * account (see docs/006-deployment.md, "Permissions and isolation").
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = 'aura1'
const DEFAULT_TTL_MS = 5 * 60_000

export const approvalKeyPath = process.env.AURA_APPROVAL_KEY_FILE
  || join(homedir(), '.config', 'aura-agent', 'approval.key')

/** Reads the HMAC key, or returns undefined when the operator has not created one yet. */
export function approvalKey() {
  if (!existsSync(approvalKeyPath)) return undefined
  const hex = readFileSync(approvalKeyPath, 'utf8').trim()
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined
}

/** Creates a 32-byte key with owner-only permissions and returns it; never overwrites one. */
export function createApprovalKey() {
  mkdirSync(join(approvalKeyPath, '..'), { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  writeFileSync(approvalKeyPath, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
  return key
}

const b64 = value => Buffer.from(value, 'utf8').toString('base64url')
const mac = (key, body) => createHmac('sha256', key).update(body).digest('base64url')

/** Mints a token binding `action` and `target` for `ttlMs`, defaulting to five minutes. */
export function issueApproval(action, target, { ttlMs = DEFAULT_TTL_MS, key = approvalKey() } = {}) {
  if (!key) throw new Error(`No approval key; run "aura-approve keygen" to create ${approvalKeyPath}.`)
  if (!action || !target) throw new Error('An approval binds an action and a target.')
  const payload = { v: 1, action, target, exp: Date.now() + ttlMs, nonce: randomBytes(12).toString('hex') }
  const body = `${VERSION}.${b64(JSON.stringify(payload))}`
  return `${body}.${mac(key, body)}`
}

export class ApprovalError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Verifies `token` for `action` and `target` and consumes its nonce, so a token works once.
 * `ledgerDir` holds one empty file per consumed nonce; creating it with `wx` is the atomic
 * claim, which is what makes two concurrent workers unable to share one approval.
 */
export function consumeApproval(token, action, target, { ledgerDir, key = approvalKey(), now = Date.now() } = {}) {
  if (!key) throw new ApprovalError('L3_APPROVAL_UNVERIFIABLE', `No approval key at ${approvalKeyPath}; run "aura-approve keygen".`)
  const parts = String(token ?? '').trim().split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new ApprovalError('L3_APPROVAL_INVALID', 'Not an approval token. L3 operations need a token from "aura-approve", not a free-form string.')
  }
  const body = `${parts[0]}.${parts[1]}`
  const given = Buffer.from(parts[2], 'utf8')
  const expected = Buffer.from(mac(key, body), 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApprovalError('L3_APPROVAL_INVALID', 'The approval token is not signed by this installation\'s key.')
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new ApprovalError('L3_APPROVAL_INVALID', 'The approval token payload is unreadable.')
  }
  if (payload.v !== 1 || typeof payload.nonce !== 'string' || typeof payload.exp !== 'number') {
    throw new ApprovalError('L3_APPROVAL_INVALID', 'The approval token payload is malformed.')
  }
  if (payload.exp <= now) throw new ApprovalError('L3_APPROVAL_EXPIRED', 'The approval token has expired; ask for a new one.')
  if (payload.action !== action) {
    throw new ApprovalError('L3_APPROVAL_MISMATCH', `The approval token authorizes "${payload.action}", not "${action}".`)
  }
  if (payload.target !== target) {
    throw new ApprovalError('L3_APPROVAL_MISMATCH', `The approval token authorizes "${payload.target}", not "${target}".`)
  }
  const ledger = ledgerDir ?? defaultLedgerDir()
  mkdirSync(ledger, { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(join(ledger, payload.nonce), 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ApprovalError('L3_APPROVAL_REUSED', 'This approval token was already used.')
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { action: payload.action, target: payload.target, nonce: payload.nonce, expiresAt: new Date(payload.exp).toISOString() }
}

function defaultLedgerDir() {
  const dataDir = process.env.AURA_DATA_DIR || join(homedir(), '.dsh', 'state', 'superagent', 'aura-data')
  return join(dataDir, 'approvals')
}
