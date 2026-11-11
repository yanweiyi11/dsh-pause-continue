import { PauseStateStore } from './pause-store.js'
import { registerRpcChannel } from './rpc-channel.js'

export const name = 'dsh-pause-continue'
export const inject = ['webServer', 'sessionController', 'agents']

const RPC_CHANNEL = '/dsh-pause-continue'
const RPC = {
  state: 'state',
  pause: 'pause',
  resume: 'resume',
}

const CONTINUE_TEXT = [
  '[Interrupted reply continuation]',
  'The previous assistant message stopped before it finished.',
  'Continue the same reply from exactly where it stopped.',
  'Do not repeat completed tool calls or text that is already present. Do not restart the answer, add a preamble, or mention the interruption.',
  'If no reply text was produced yet, continue the task from the last completed tool call.',
].join(' ')

const NON_RESUMABLE_CODES = new Set(['ACCOUNT_SIGNED_OUT', 'ACCOUNT_SIGN_IN_REQUIRED', 'QUOTA', 'ACCOUNT_QUOTA', 'AUTH'])

let requestSequence = 0

export function apply(ctx) {
  const store = new PauseStateStore()
  const ready = store.load()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    void (async () => {
      await ready
      const entry = store.get(session.id)
      if (entry?.paused !== true) return
      const agent = ctx.agents.get(session.id)
      const pending = entry.pending
      await store.cancelPause(session.id)
      if (agent !== undefined) restoreMessages(agent, pending)
    })().catch((error) => console.warn('[dsh-pause-continue] could not abandon pause', error))
  }), 'dsh-pause-continue: abandon pause on user prompt')

  const handler = async (endpoint, payload) => {
    try {
      await ready
      const sessionId = readSessionId(payload)
      let result
      if (endpoint === RPC.state) result = ok(await stateOf(ctx, store, sessionId))
      else if (endpoint === RPC.pause) result = ok(await pauseSession(ctx, store, sessionId))
      else if (endpoint === RPC.resume) result = ok(await resumeSession(ctx, store, sessionId))
      else result = fail('gateway/bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
      return result
    } catch (error) {
      return fail('pause-continue/internal', error instanceof Error ? error.message : String(error))
    }
  }

  registerRpcChannel(ctx, RPC_CHANNEL, handler)
}

async function stateOf(ctx, store, sessionId) {
  const agent = ctx.agents.get(sessionId)
  let entry = store.get(sessionId)
  if (entry?.paused !== true && agent?.status !== 'running') {
    const failedTurn = resumableErrorTurn(agent)
    if (failedTurn !== null && !entry?.pairs?.some((pair) => pair.turn === failedTurn)) {
      await store.pause(sessionId, failedTurn, { nextTurn: [], nextStep: [] })
      entry = store.get(sessionId)
    }
  }
  return {
    paused: entry?.paused === true,
    pausedAt: entry?.pausedAt ?? null,
    running: agent?.status === 'running',
    turn: entry?.turn ?? null,
    currentTurn: agent === undefined ? null : ctx.agents.turnBoundaryOf(agent.session).lastTurn,
    pairs: entry?.pairs ?? [],
  }
}

function resumableErrorTurn(agent) {
  if (agent === undefined) return null
  try {
    const session = agent.session
    const last = session.seq - 1
    const first = Math.max(0, last - 200)
    for (let i = last; i >= first; i--) {
      const event = session.eventAt(i)
      if (event === undefined) continue
      if (event.type === 'user/message') {
        if (event.data?.source?.kind === 'user') return null
        continue
      }
      if (event.type === 'turn/start') return null
      if (event.type !== 'turn/end') continue
      const reason = event.data?.reason
      if (reason?.kind !== 'error') return null
      if (NON_RESUMABLE_CODES.has(reason.error?.code)) return null
      return Number.isInteger(event.data?.turn) ? event.data.turn : null
    }
  } catch (error) {
    console.warn('[dsh-pause-continue] could not inspect last turn', error)
  }
  return null
}

async function pauseSession(ctx, store, sessionId) {
  const existing = store.get(sessionId)
  const agent = ctx.agents.get(sessionId)
  if (existing?.paused === true) {
    if (agent?.status !== 'running') return stateOf(ctx, store, sessionId)
    const pending = existing.pending
    await store.cancelPause(sessionId)
    if (agent !== undefined) restoreMessages(agent, pending)
  }
  if (agent === undefined || agent.status !== 'running') {
    return { paused: false, running: agent?.status === 'running', turn: null, pairs: store.get(sessionId)?.pairs ?? [] }
  }

  const pending = {
    nextTurn: cloneMessages(agent.inbox.nextTurn),
    nextStep: cloneMessages(agent.inbox.nextStep),
  }
  const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn
  await store.pause(sessionId, turn, pending)
  try {
    agent.cancel({ kind: 'user' }, { keepInbox: false })
  } catch (error) {
    await store.cancelPause(sessionId)
    throw error
  }
  await waitForIdle(agent)
  return stateOf(ctx, store, sessionId)
}

async function resumeSession(ctx, store, sessionId) {
  const record = store.get(sessionId)
  if (record === undefined || record.paused !== true) return stateOf(ctx, store, sessionId)

  let agent = ctx.agents.get(sessionId)
  let extra = { nextTurn: [], nextStep: [] }
  if (agent !== undefined) {
    extra = {
      nextTurn: cloneMessages(agent.inbox.nextTurn),
      nextStep: cloneMessages(agent.inbox.nextStep),
    }
    if (extra.nextTurn.length > 0 || extra.nextStep.length > 0) agent.inbox.clear()
  }

  try {
    // ponytail: internal session-controller prompt seam; replace when a public source-aware prompt API exists.
    await ctx.sessionController.commands.prompt({
      requestId: `pause-continue-${Date.now()}-${++requestSequence}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: CONTINUE_TEXT }],
    }, { kind: 'pause-continue' })
  } catch (error) {
    agent = ctx.agents.get(sessionId)
    if (agent !== undefined) restoreMessages(agent, extra)
    throw error
  }

  agent = ctx.agents.get(sessionId)
  const resumedTurn = agent === undefined
    ? (record.turn ?? 0) + 1
    : Math.max((record.turn ?? 0) + 1, ctx.agents.turnBoundaryOf(agent.session).lastTurn)
  await store.resume(sessionId, resumedTurn)
  if (agent !== undefined) {
    restoreMessages(agent, {
      nextStep: [...record.pending?.nextStep ?? [], ...extra.nextStep],
      nextTurn: [...record.pending?.nextTurn ?? [], ...extra.nextTurn],
    })
  }
  return stateOf(ctx, store, sessionId)
}

function restoreMessages(agent, pending) {
  for (const message of pending.nextStep ?? []) agent.steer(message)
  for (const message of pending.nextTurn ?? []) agent.followup(message)
}

function readSessionId(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object')
  }
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
    throw new Error('sessionId must be a non-empty string')
  }
  return sessionId
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages))
}

async function waitForIdle(agent) {
  await Promise.race([
    agent.whenIdle().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}
