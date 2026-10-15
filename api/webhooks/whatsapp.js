import crypto from 'node:crypto'

const EVENT_TABLE = 'whatsapp_webhook_events'

export const config = {
  api: {
    bodyParser: false,
  },
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest()
}

function timingSafeEqualString(left, right) {
  return crypto.timingSafeEqual(sha256(left), sha256(right))
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function isWebRequest(req) {
  return Boolean(req && typeof req.headers?.get === 'function' && typeof req.text === 'function')
}

function isNodeResponse(res) {
  return Boolean(res && (typeof res.end === 'function' || typeof res.status === 'function'))
}

function getHubParamsFromUrl(urlString, base) {
  const url = new URL(urlString, base)
  return {
    mode: url.searchParams.get('hub.mode'),
    token: url.searchParams.get('hub.verify_token'),
    challenge: url.searchParams.get('hub.challenge'),
  }
}

function getHubParams(req) {
  if (isWebRequest(req)) {
    return getHubParamsFromUrl(req.url)
  }

  const query = req.query || {}
  const fromQuery = {
    mode: firstValue(query['hub.mode']),
    token: firstValue(query['hub.verify_token']),
    challenge: firstValue(query['hub.challenge']),
  }
  if (fromQuery.mode || fromQuery.token || fromQuery.challenge) {
    return fromQuery
  }

  const host = req.headers?.host || 'localhost'
  const proto = req.headers?.['x-forwarded-proto'] || 'https'
  return getHubParamsFromUrl(req.url || '/', `${proto}://${host}`)
}

function verifyResult(params) {
  const mode = String(params.mode || '').trim()
  const token = String(params.token || '').trim()
  const challenge = params.challenge == null ? '' : String(params.challenge)
  const expected = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim()

  if (!expected) {
    console.error('whatsapp webhook: WHATSAPP_VERIFY_TOKEN is not set')
    return { status: 403, body: 'Forbidden' }
  }

  if (mode === 'subscribe' && token && challenge && timingSafeEqualString(token, expected)) {
    return { status: 200, body: challenge }
  }

  return { status: 403, body: 'Forbidden' }
}

function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false
  const prefix = 'sha256='
  if (!signatureHeader.startsWith(prefix)) return false

  let received
  try {
    received = Buffer.from(signatureHeader.slice(prefix.length), 'hex')
  } catch {
    return false
  }

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest()
  if (received.length !== expected.length) return false
  return crypto.timingSafeEqual(received, expected)
}

async function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function collectEvents(payload) {
  const rows = []
  const entries = Array.isArray(payload?.entry) ? payload.entry : []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value ?? {}
      const phoneNumberId = value?.metadata?.phone_number_id ?? null

      const messages = Array.isArray(value.messages) ? value.messages : []
      for (const message of messages) {
        const waMessageId = typeof message?.id === 'string' ? message.id : null
        if (!waMessageId) continue
        rows.push({
          event_key: `message:${waMessageId}`,
          event_type: 'inbound_message',
          wa_message_id: waMessageId,
          wa_status: null,
          from_wa_id: typeof message.from === 'string' ? message.from : null,
          message_type: typeof message.type === 'string' ? message.type : null,
          phone_number_id: phoneNumberId,
        })
      }

      const statuses = Array.isArray(value.statuses) ? value.statuses : []
      for (const status of statuses) {
        const waMessageId = typeof status?.id === 'string' ? status.id : null
        const waStatus = typeof status?.status === 'string' ? status.status : null
        if (!waMessageId || !waStatus) continue
        rows.push({
          event_key: `status:${waMessageId}:${waStatus}`,
          event_type: 'status',
          wa_message_id: waMessageId,
          wa_status: waStatus,
          from_wa_id: typeof status.recipient_id === 'string' ? status.recipient_id : null,
          message_type: null,
          phone_number_id: phoneNumberId,
        })
      }
    }
  }

  return rows
}

async function persistEvents(rows) {
  if (rows.length === 0) {
    return { inserted: 0, duplicates: 0, skipped: true }
  }

  const supabase = await getServiceClient()
  if (!supabase) {
    console.warn('whatsapp webhook: persistence skipped (server database env not set)')
    return { inserted: 0, duplicates: 0, skipped: true }
  }

  const { data, error } = await supabase
    .from(EVENT_TABLE)
    .upsert(rows, { onConflict: 'event_key', ignoreDuplicates: true })
    .select('event_key')

  if (error) throw error

  const inserted = data?.length ?? 0
  return { inserted, duplicates: rows.length - inserted, skipped: false }
}

async function readNodeRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body)
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody)
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody

  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function getNodeHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return firstValue(value)
}

async function handlePost(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) {
    console.error('whatsapp webhook: missing server secret for signature verification')
    return { status: 500, body: 'Server misconfigured' }
  }

  if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
    return { status: 401, body: 'Invalid signature' }
  }

  let payload
  try {
    payload = rawBody ? JSON.parse(rawBody.toString('utf8')) : null
  } catch {
    console.warn('whatsapp webhook: malformed JSON after valid signature')
    return { status: 200, body: 'OK' }
  }

  let rows
  try {
    rows = collectEvents(payload)
  } catch {
    console.warn('whatsapp webhook: unexpected payload shape')
    return { status: 200, body: 'OK' }
  }

  try {
    const result = await persistEvents(rows)
    console.info(
      `whatsapp webhook: events=${rows.length} inserted=${result.inserted} duplicates=${result.duplicates} persistence=${result.skipped ? 'skipped' : 'ok'}`,
    )
  } catch {
    console.error('whatsapp webhook: failed to persist events')
    return { status: 503, body: 'Temporarily unavailable' }
  }

  return { status: 200, body: 'OK' }
}

function sendNode(res, status, body) {
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(status).setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.send(body)
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

export async function GET(request) {
  const result = verifyResult(getHubParams(request))
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function POST(request) {
  let rawBody
  try {
    rawBody = Buffer.from(await request.text())
  } catch {
    return new Response('Invalid body', { status: 400 })
  }
  const result = await handlePost(rawBody, request.headers.get('x-hub-signature-256'))
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export default async function handler(req, res) {
  if (isWebRequest(req) && !isNodeResponse(res)) {
    if (req.method === 'GET') return GET(req)
    if (req.method === 'POST') return POST(req)
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    if (req.method === 'GET') {
      const result = verifyResult(getHubParams(req))
      return sendNode(res, result.status, result.body)
    }
    if (req.method === 'POST') {
      const rawBody = await readNodeRawBody(req)
      const signature = getNodeHeader(req, 'x-hub-signature-256')
      const result = await handlePost(rawBody, signature)
      return sendNode(res, result.status, result.body)
    }
    return sendNode(res, 405, 'Method Not Allowed')
  } catch {
    console.error('whatsapp webhook: unhandled error')
    return sendNode(res, 500, 'Error')
  }
}
