import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STATE_VERSION = 2
const MAX_PAIRS = 50

function stateFile() {
  return join(process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? process.cwd(), 'dsh-pause-continue-state.json')
}

/** Paused sessions, held inbox items, and completed continuation pairs. */
export class PauseStateStore {
  #entries = new Map()
  #loaded = false
  #writes = Promise.resolve()

  async load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(await readFile(stateFile(), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') return
      const version = parsed.version
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        if (sessionId === '' || value === null || typeof value !== 'object') continue
        const paused = version === STATE_VERSION
          ? value.paused === true
          : typeof value.pausedAt === 'number'
        this.#entries.set(sessionId, {
          paused,
          pausedAt: typeof value.pausedAt === 'number' ? value.pausedAt : null,
          turn: typeof value.turn === 'number' ? value.turn : null,
          pending: sanitizePending(value.pending),
          pairs: sanitizePairs(value.pairs),
        })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[dsh-pause-continue] could not read pause state', error)
    }
  }

  get(sessionId) {
    return this.#entries.get(sessionId)
  }

  async pause(sessionId, turn, pending) {
    const existing = this.#entries.get(sessionId)
    this.#entries.set(sessionId, {
      paused: true,
      pausedAt: Date.now(),
      turn,
      pending: sanitizePending(pending),
      pairs: existing?.pairs ?? [],
    })
    await this.#save()
  }

  async resume(sessionId, resumedTurn) {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return
    const pairs = entry.turn === null
      ? entry.pairs
      : [...entry.pairs, { turn: entry.turn, resumedTurn }].slice(-MAX_PAIRS)
    this.#entries.set(sessionId, {
      paused: false,
      pausedAt: null,
      turn: null,
      pending: { nextTurn: [], nextStep: [] },
      pairs,
    })
    await this.#save()
  }

  async cancelPause(sessionId) {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return
    this.#entries.set(sessionId, {
      paused: false,
      pausedAt: null,
      turn: null,
      pending: { nextTurn: [], nextStep: [] },
      pairs: entry.pairs,
    })
    await this.#save()
  }

  async #save() {
    const body = JSON.stringify({
      version: STATE_VERSION,
      sessions: Object.fromEntries(this.#entries),
    }, null, 2)
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      const file = stateFile()
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, file)
    })
    await this.#writes
  }
}

function sanitizePending(value) {
  if (value === null || typeof value !== 'object') return { nextTurn: [], nextStep: [] }
  return {
    nextTurn: sanitizeMessages(value.nextTurn),
    nextStep: sanitizeMessages(value.nextStep),
  }
}

function sanitizeMessages(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isMessageLike).map(clone)
}

function sanitizePairs(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((pair) => pair !== null && typeof pair === 'object'
      && Number.isInteger(pair.turn) && pair.turn > 0
      && Number.isInteger(pair.resumedTurn) && pair.resumedTurn > pair.turn)
    .map((pair) => ({ turn: pair.turn, resumedTurn: pair.resumedTurn }))
    .slice(-MAX_PAIRS)
}

function isMessageLike(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string'
    && Array.isArray(value.content)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}
