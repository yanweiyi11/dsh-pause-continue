const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/
const CLIENT_REQUEST = 'client-request'
const SERVER_RESPONSE = 'server-response'
const MAX_REQUEST_BYTES = 1 << 20

/** Register one exact loopback RPC channel on the Host connection service or its web fallback. */
export function registerRpcChannel(ctx, channel, handler) {
  return ctx.effect(() => {
    const connection = getConnection(ctx)
    const viaService = tryServiceChannel(connection, channel, handler)
    if (viaService !== undefined) return viaService
    return mountDirectRoute(ctx, connection, channel, handler)
  }, `dsh-pause-continue: ${channel} RPC channel`)
}

function getConnection(ctx) {
  try {
    return ctx.get('connection')
  } catch {
    return undefined
  }
}

function tryServiceChannel(connection, channel, handler) {
  const rpc = connection?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') return undefined
  try {
    const release = rpc.handle(channel, handler, { authority: 'loopback' })
    if (typeof release !== 'function') return undefined
    return () => { void release() }
  } catch (error) {
    console.warn(`[dsh-pause-continue] connection.rpc.handle() could not mount ${channel}; using the web server route`, error)
    return undefined
  }
}

function mountDirectRoute(ctx, connection, channel, handler) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error(`dsh-pause-continue: webServer is unavailable, so ${channel} cannot be mounted`)
  }
  const reject = connection?.requestRejection
  if (connection !== undefined && typeof reject !== 'function') {
    throw new Error(`dsh-pause-continue: connection.requestRejection is unavailable, so ${channel} cannot be mounted behind the connection trust fence`)
  }
  if (connection === undefined) {
    console.warn(`[dsh-pause-continue] ${channel} mounted through webServer without the connection trust fence`)
  }
  return webServer.register({
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = reject?.call(connection, req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await answer(req, res, channel, handler)
    },
  })
}

async function answer(req, res, channel, handler) {
  const endpoint = endpointOf(channel, req.url)
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  const body = await readBody(req)
  if (body.kind === 'too-large') {
    res.writeHead(413)
    res.end('request body too large')
    return
  }
  if (body.kind === 'invalid') {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const envelope = requestEnvelope(body.value)
  if (envelope === undefined) {
    write(res, rpcIdOf(body.value), {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    })
    return
  }
  if (envelope.method !== endpoint) {
    write(res, envelope.rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
    })
    return
  }
  const controller = new AbortController()
  res.on('close', () => { controller.abort() })
  try {
    write(res, envelope.rpcId, await handler(endpoint, envelope.payload, controller.signal))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

function endpointOf(channel, rawUrl) {
  const pathname = new URL(rawUrl ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) return undefined
  return endpoint
}

function requestEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (value.type !== CLIENT_REQUEST || typeof value.rpcId !== 'string' || typeof value.method !== 'string') return undefined
  return { rpcId: value.rpcId, method: value.method, payload: value.payload }
}

function rpcIdOf(value) {
  return typeof value?.rpcId === 'string' ? value.rpcId : 'invalid-request'
}

function write(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: SERVER_RESPONSE, rpcId, result }))
}

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) return { kind: 'too-large' }
    chunks.push(buffer)
  }
  try {
    return { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { kind: 'invalid' }
  }
}
