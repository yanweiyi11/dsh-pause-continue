window.__ModuleLoader__.load({
  id: 'dsh-pause-continue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-pause-continue'
    const CHANNEL = '/dsh-pause-continue'
    const EMPTY_STATE = Object.freeze({ status: 'idle', paused: false, pausedAt: null, running: false, turn: null, currentTurn: null, pairs: [] })
    const states = new Map()
    const listeners = new Set()

    const zh = {
      'pause.pause': '暂停生成',
      'pause.resume': '继续生成',
    }
    const en = {
      'pause.pause': 'Pause generation',
      'pause.resume': 'Continue generation',
    }

    function readState(sessionId) {
      return states.get(sessionId) ?? EMPTY_STATE
    }

    function writeState(sessionId, value) {
      states.set(sessionId, value)
      for (const listener of [...listeners]) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function usePauseState(sessionId) {
      return React.useSyncExternalStore(
        subscribe,
        () => readState(sessionId),
        () => readState(sessionId),
      )
    }

    function normalizeState(value) {
      const pairs = Array.isArray(value?.pairs)
        ? value.pairs.filter((pair) => Number.isInteger(pair?.turn) && Number.isInteger(pair?.resumedTurn))
        : []
      return {
        status: 'ready',
        paused: value?.paused === true,
        pausedAt: typeof value?.pausedAt === 'number' ? value.pausedAt : null,
        running: value?.running === true,
        turn: Number.isInteger(value?.turn) ? value.turn : null,
        currentTurn: Number.isInteger(value?.currentTurn) ? value.currentTurn : null,
        pairs,
      }
    }

    function createApi(connection) {
      async function call(method, sessionId) {
        const result = await connection.rpc.call(CHANNEL, method, { sessionId })
        if (!result?.ok) throw new Error(result?.error?.message ?? `${method} rejected`)
        return result.value
      }
      return {
        state: (sessionId) => call('state', sessionId),
        pause: (sessionId) => call('pause', sessionId),
        resume: (sessionId) => call('resume', sessionId),
      }
    }

    function pairRules(pairs) {
      return pairs.map(({ turn, resumedTurn }) => {
        const gate = `[data-slot="conversation.chat.flow"]:has([data-chat-turn="${turn}"]):has([data-chat-flow-kind="assistant-step"][data-chat-turn="${resumedTurn}"])`
        return [
          `${gate} [data-chat-flow-kind="assistant-step"][data-chat-turn="${turn}"]{display:none!important}`,
          `${gate} [data-chat-flow-kind="turn-process"][data-chat-turn="${turn}"]{display:none!important}`,
          `${gate} [data-chat-flow-kind="turn-tail"][data-chat-turn="${turn}"]{display:none!important}`,
          `${gate} [data-chat-flow-kind="model-retry"][data-chat-turn="${turn}"]{display:none!important}`,
          `${gate} [data-chat-flow-kind="turn-error"][data-chat-turn="${turn}"]{display:none!important}`,
          `[data-chat-flow-kind="turn-trigger"][data-chat-turn="${resumedTurn}"]{display:none!important}`,
          `[data-chat-flow-kind="turn-process"][data-chat-turn="${resumedTurn}"]{display:none!important}`,
          `[data-chat-flow-kind="assistant-step"][data-chat-turn="${resumedTurn}"]:has(~ [data-chat-flow-kind="assistant-step"][data-chat-turn="${resumedTurn}"]){display:none!important}`,
          `[data-chat-flow-kind="assistant-step"][data-chat-turn="${resumedTurn}"]{margin-top:0!important}`,
        ].join('\n')
      }).join('\n')
    }

    function PauseControl({ useSession, sessionId, useAccess, t, api }) {
      const running = useSession((session) => session.running) ?? false
      const subagent = useSession((session) => session.subagent) ?? null
      const state = usePauseState(sessionId)
      const [busy, setBusy] = React.useState(false)
      const cancelAllowed = useAccess('session/cancel') !== false
      const promptAllowed = useAccess('session/prompt') !== false

      React.useEffect(() => {
        let cancelled = false
        const current = readState(sessionId)
        if (current.status === 'idle') writeState(sessionId, { ...current, status: 'loading' })
        api.state(sessionId).then((value) => {
          if (!cancelled) writeState(sessionId, normalizeState(value))
        }).catch((error) => {
          if (!cancelled) {
            console.warn('[dsh-pause-continue] state read failed', error)
            writeState(sessionId, { ...current, status: 'error' })
          }
        })
        return () => { cancelled = true }
      }, [api, sessionId, running])

      React.useEffect(() => {
        if (!state.paused || !running) return
        const timer = setInterval(() => {
          api.state(sessionId).then((value) => {
            const next = normalizeState(value)
            if (!next.paused) {
              writeState(sessionId, next)
              return
            }
            if (state.turn !== null && next.currentTurn !== null && next.currentTurn > state.turn) {
              writeState(sessionId, { ...next, paused: false })
            }
          }).catch(() => {})
        }, 400)
        return () => clearInterval(timer)
      }, [api, sessionId, state.paused, state.turn, running])

      React.useEffect(() => {
        if (running || !state.paused) return
        const timer = setTimeout(() => {
          api.state(sessionId).then((value) => {
            const next = normalizeState(value)
            if (!next.paused) writeState(sessionId, next)
          }).catch(() => {})
        }, 300)
        return () => clearTimeout(timer)
      }, [api, running, sessionId, state.paused])

      if (subagent !== null) return null
      const paused = state.paused && !running
      const active = running || state.paused
      const showButton = active && (paused ? promptAllowed : cancelAllowed)
      if (!active && state.pairs.length === 0) return null

      const label = paused ? t('pause.resume') : t('pause.pause')
      const disabled = busy
      const onClick = async () => {
        if (disabled) return
        setBusy(true)
        try {
          const value = paused ? await api.resume(sessionId) : await api.pause(sessionId)
          writeState(sessionId, normalizeState(value))
        } catch (error) {
          console.warn('[dsh-pause-continue] action failed', error)
        } finally {
          setBusy(false)
        }
      }

      const css = [
        '.dsh-pause-continue-control{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px);padding:0}',
        '.dsh-pause-continue-control:disabled{cursor:default;opacity:.55}',
        '.dsh-pause-continue-control:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
        '.dsh-pause-continue-control svg{width:16px;height:16px;display:block}',
        '[data-composer-card]:has([data-dsh-pause-continue-control]) button:not([data-dsh-pause-continue-control]):has(> svg > rect){display:none!important}',
        '[data-composer-card]:has([data-dsh-pause-continue-control][data-dsh-pause-continue-state="paused"]):has([data-composer-placeholder]) button[class*="_primary"]{display:none!important}',
        '[data-composer-card]:has([data-dsh-pause-continue-control][data-dsh-pause-continue-state="paused"]):not(:has([data-composer-placeholder])) [data-dsh-pause-continue-control]{display:none!important}',
        pairRules(state.pairs),
      ].join('\n')

      return h(React.Fragment, null,
        h('style', { key: 'style', 'data-dsh-pause-continue': '' }, css),
        showButton && h('button', {
          key: 'button',
          type: 'button',
          className: 'dsh-pause-continue-control',
          'data-dsh-pause-continue-control': '',
          'data-dsh-pause-continue-state': paused ? 'paused' : 'running',
          'aria-label': label,
          title: label,
          disabled,
          onClick,
        }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
          paused
            ? h('path', { d: 'M5 3.2 13 8l-8 4.8Z', fill: 'currentColor' })
            : [
                h('rect', { key: 'left', x: 4, y: 3, width: 3.2, height: 10, rx: 1, fill: 'currentColor' }),
                h('rect', { key: 'right', x: 8.8, y: 3, width: 3.2, height: 10, rx: 1, fill: 'currentColor' }),
              ],
        )),
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.inject(['slots', 'locale', 'connection'], (injected) => {
          injected.effect(
            () => injected.locale.register(NS, { zh, en }),
            'dsh-pause-continue: locale',
          )
          const api = createApi(injected.connection)
          injected.slots.inject('conversation.input.activity', () => injected.slots.register({
            name: 'conversation.input.activity',
            id: 'dsh-pause-continue',
            order: 5,
            locale: NS,
          }, (props) => h(PauseControl, { ...props, api })))
        })
      },
    }
  },
})
