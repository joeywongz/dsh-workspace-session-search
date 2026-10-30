/**
 * Standalone host-half tests for dsh-workspace-session-search.
 *
 * Node builtins only (no test framework): `node test/host.test.mjs` exits
 * non-zero on failure and prints one ✔/✖ line per check plus a final count.
 *
 * Covers CONTRACT.md §3:
 *  - service registration + source-mode Remote discovery metadata (real
 *    `remoteMethods()` helper from the profile when importable);
 *  - search(): multi-turn grouping, workspace/cwd filtering, provider ordering,
 *    per-session failure fallback, title tolerance, cursor pagination, clamps,
 *    empty-query and disabled-index error mapping;
 *  - recent(): newest-first, cwd filter, clamps, title tolerance;
 *  - lossless-JSON response contract;
 *  - optional in-process real-Gateway integration probe (/tmp/dsh-probe).
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

let checks = 0
const failures = []

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`✔ ${label}\n`)
    return true
  }
  failures.push(label)
  process.stdout.write(`✖ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  return false
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

/** Return a human-readable reason why `value` is not lossless JSON, or `null`. */
function losslessProblem(value, path = '$', ancestors = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return null
  if (type === 'number') {
    if (!Number.isFinite(value)) return `${path} is not a finite number (${String(value)})`
    if (Object.is(value, -0)) return `${path} is negative zero`
    return null
  }
  if (type !== 'object') return `${path} is ${type}`
  if (ancestors.has(value)) return `${path} is cyclic`
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return `${path} is not a plain array`
      if (Reflect.ownKeys(value).length !== value.length + 1) return `${path} is sparse`
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return `${path}[${index}] is missing`
        const problem = losslessProblem(value[index], `${path}[${index}]`, ancestors)
        if (problem !== null) return problem
      }
      return null
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return `${path} is a class instance`
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return `${path} has a symbol key`
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || descriptor.enumerable !== true) return `${path}.${key} is not enumerable`
      const nested = value[key]
      if (nested === undefined) return `${path}.${key} is undefined`
      const problem = losslessProblem(nested, `${path}.${key}`, ancestors)
      if (problem !== null) return problem
    }
    return null
  } finally {
    ancestors.delete(value)
  }
}

function checkLossless(label, value) {
  const problem = losslessProblem(value)
  let roundTrips = false
  if (problem === null) {
    try {
      roundTrips = deepEqual(JSON.parse(JSON.stringify(value)), value)
    } catch {
      roundTrips = false
    }
  }
  check(label, problem === null && roundTrips, problem ?? 'JSON.stringify round-trip differs')
}

/** Parse the plain identifier parameter list of one SRC Remote method. */
function parameterNamesOf(method) {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  if (open < 0 || close < 0) return []
  const body = source.slice(open + 1, close).trim()
  if (body === '') return []
  return body.split(',').map((part) => part.trim())
}

// --------------------------------------------------------------- fake host ctx

function createHostContext(sessionQuery) {
  const provided = new Map()
  const ctx = {
    sessionQuery,
    provided,
    effect(fn) {
      return () => {
        void fn
      }
    },
    inject(names, callback) {
      return callback(ctx)
    },
    sessions: {
      get() {
        return undefined
      },
    },
    provide(name, value) {
      if (provided.has(name)) throw new Error(`service ${JSON.stringify(name)} is already provided`)
      provided.set(name, value)
      return () => {
        provided.delete(name)
      }
    },
    get(name) {
      if (name === 'sessionQuery') return sessionQuery
      return provided.get(name)
    },
  }
  return ctx
}

function loadPlugin(sessionQuery) {
  const ctx = createHostContext(sessionQuery)
  plugin.apply(ctx)
  const service = ctx.provided.get('workspaceSessionSearch')
  return { ctx, service }
}

/** Fake `ctx.sessionQuery` recording every provider call. */
function createSessionQuery(handlers = {}) {
  const calls = { searchSessions: [], searchEvents: [], readTitleSnapshots: [], listSessions: 0 }
  return {
    calls,
    async searchSessions(request, exec) {
      calls.searchSessions.push({ request, exec })
      if (handlers.searchSessions !== undefined) return handlers.searchSessions(request, exec)
      return { items: [] }
    },
    async searchEvents(request, exec) {
      calls.searchEvents.push({ request, exec })
      if (handlers.searchEvents !== undefined) return handlers.searchEvents(request, exec)
      return { session: { id: request.sessionId }, items: [] }
    },
    async readTitleSnapshots(sessionIds, signal) {
      calls.readTitleSnapshots.push({ sessionIds, signal })
      if (handlers.readTitleSnapshots !== undefined) return handlers.readTitleSnapshots(sessionIds, signal)
      return sessionIds.map((sessionId) => ({ status: 'fulfilled', value: { session: { id: sessionId } } }))
    },
    async listSessions(signal) {
      calls.listSessions += 1
      if (handlers.listSessions !== undefined) return handlers.listSessions(signal)
      return []
    },
  }
}

// ------------------------------------------------------------------- fixtures

const CREATED_AT = 1700000000000

function headerOf(id, cwd, options = {}) {
  const header = { version: 1, id, createdAt: options.createdAt ?? CREATED_AT, isSeeded: false }
  if (typeof cwd === 'string') header.cwd = cwd
  if (typeof options.parentSession === 'string') header.parentSession = options.parentSession
  return header
}

function recordOf(id, cwd, options = {}) {
  return {
    header: headerOf(id, cwd, options),
    live: options.live ?? true,
    persisted: options.persisted ?? true,
  }
}

function hitOf(sessionId, seq, options = {}) {
  return {
    sessionId,
    seq,
    type: options.type ?? 'user/message',
    time: options.time ?? CREATED_AT + 1000 + seq,
    surface: options.surface ?? 'current',
    snippet: options.snippet ?? `snippet ${seq}`,
  }
}

function searchItemOf(record, bestMatch) {
  return { ...record, bestMatch }
}

function titleObservation(header, title) {
  return { status: 'fulfilled', value: { session: header, title: { title, eventSeq: 1, updatedAt: CREATED_AT, messageSeqs: [], source: { kind: 'fallback' } } } }
}

// ------------------------------------------------- registration + discovery

const expectedFilters = [
  { kind: 'type', values: ['user/message', 'assistant/message'] },
  { kind: 'surface', values: ['current'] },
]
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

{
  const fake = createSessionQuery()
  const { ctx, service } = loadPlugin(fake)
  check('registration: ctx.provide captured the service', service !== undefined && typeof service === 'object')
  check(
    'registration: exactly one service is registered',
    ctx.provided.size === 1 && ctx.provided.get('workspaceSessionSearch') === service,
  )
  check('plugin exports: name', plugin.name === 'workspace-session-search')
  check('plugin exports: inject', deepEqual(plugin.inject, ['sessionQuery']))
  check('plugin exports: apply is a function', typeof plugin.apply === 'function')

  const binding = service.typertRemote
  check('discovery: typertRemote binding is a frozen object', binding !== null && typeof binding === 'object' && Object.isFrozen(binding))
  check('discovery: binding.service is the provided instance', binding.service === service)
  check('discovery: binding.serviceKey', binding.serviceKey === 'workspaceSessionSearch')
  check('discovery: binding.namespace', binding.namespace === 'workspaceSessionSearch')

  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), REMOTE_METHOD_DESCRIPTOR)
  check(
    'discovery: prototype carries the remote-methods descriptor',
    descriptor !== undefined && descriptor.value !== null && typeof descriptor.value === 'object',
  )
  const markers = descriptor?.value?.methods
  check('discovery: descriptor version is 1', descriptor?.value?.version === 1)
  check(
    'discovery: methods are search then recent',
    Array.isArray(markers) && markers.map((marker) => marker.method).join(',') === 'search,recent',
  )
  check(
    'discovery: every marker is a direct invocation',
    Array.isArray(markers) && markers.every((marker) => marker.invocation !== undefined && marker.invocation.kind === 'direct'),
  )
  check(
    'discovery: markers declare no exportName override',
    Array.isArray(markers) && markers.every((marker) => !Object.hasOwn(marker, 'exportName')),
  )
  check(
    'wire: search parameter list is exactly [request]',
    deepEqual(parameterNamesOf(service.search), ['request']),
    JSON.stringify(parameterNamesOf(service.search)),
  )
  check(
    'wire: recent parameter list is exactly [request]',
    deepEqual(parameterNamesOf(service.recent), ['request']),
    JSON.stringify(parameterNamesOf(service.recent)),
  )
  check(
    'wire: methods live on the class prototype (not instance arrows)',
    Object.hasOwn(Object.getPrototypeOf(service), 'search') && Object.hasOwn(Object.getPrototypeOf(service), 'recent'),
  )

  const protocol = await loadProtocolModule()
  if (protocol === null) {
    process.stdout.write('… discovery: protocol helper unavailable, verified the marker property directly\n')
    check('discovery: descriptor readable without the protocol module', Array.isArray(markers) && markers.length === 2)
  } else {
    process.stdout.write(`… discovery: cross-checked with ${protocol.path}\n`)
    const viaProtocol = protocol.module.remoteMethods(service)
    check(
      'discovery: real remoteMethods() finds both SRC methods',
      viaProtocol.length === 2 &&
        viaProtocol[0].method === 'search' &&
        viaProtocol[1].method === 'recent' &&
        viaProtocol.every((marker) => marker.invocation.kind === 'direct'),
      JSON.stringify(viaProtocol),
    )
    check(
      'discovery: real remoteMethods() output matches the hand-written descriptor',
      deepEqual(
        viaProtocol.map((marker) => ({ method: marker.method, kind: marker.invocation.kind })),
        [{ method: 'search', kind: 'direct' }, { method: 'recent', kind: 'direct' }],
      ),
    )
  }
  check('registration: service exposes both wire methods', typeof service.search === 'function' && typeof service.recent === 'function')
  void fake
}

// ------------------------------------------------------------------ search()

process.stdout.write('\n— search() —\n')

{
  const header = headerOf('s1', '/workspace/alpha')
  const bestMatch = hitOf('s1', 5)
  const turns = [hitOf('s1', 5), hitOf('s1', 3, { type: 'assistant/message' }), hitOf('s1', 1)]
  const fake = createSessionQuery({
    searchSessions: () => ({ items: [searchItemOf(recordOf('s1', '/workspace/alpha'), bestMatch)] }),
    searchEvents: () => ({ session: header, items: turns }),
    readTitleSnapshots: () => [titleObservation(header, 'Alpha planning')],
  })
  const { service } = loadPlugin(fake)
  const response = await service.search({ query: '  alpha  ' })
  check('search: one session group for three matching turns', response.sessions.length === 1)
  const group = response.sessions[0]
  check('search: query is trimmed and echoed', response.query === 'alpha')
  check('search: all three turns are grouped under the session', group.hits.length === 3)
  check('search: provider hit order preserved (strongest first)', group.hits.map((hit) => hit.seq).join(',') === '5,3,1')
  check('search: hit message types preserved', group.hits[0].type === 'user/message' && group.hits[1].type === 'assistant/message')
  check('search: title folded from the snapshot', group.title === 'Alpha planning')
  check(
    'search: session summary fields',
    group.sessionId === 's1' && group.cwd === '/workspace/alpha' && group.createdAt === CREATED_AT && group.live === true,
  )
  check('search: bestMatch is the strongest turn', group.bestMatch.seq === 5 && group.bestMatch.snippet === 'snippet 5')
  check(
    'search: wire hit exposes only seq/type/time/snippet',
    group.hits.every((hit) => deepEqual(Object.keys(hit).sort(), ['seq', 'snippet', 'time', 'type'])),
  )
  check('search: no nextCursor key when the provider has none', response.hasMore === false && !Object.hasOwn(response, 'nextCursor'))
  check('search: no parentSessionId key when the header has none', !Object.hasOwn(group, 'parentSessionId'))

  const sessionCall = fake.calls.searchSessions[0]?.request
  const eventCall = fake.calls.searchEvents[0]?.request
  check('search: default sessionLimit is 30', sessionCall?.limit === 30)
  check('search: session request carries message/current event filters', deepEqual(sessionCall?.eventFilters, expectedFilters))
  check('search: no cursor forwarded when absent', sessionCall !== undefined && !Object.hasOwn(sessionCall, 'cursor'))
  check('search: default hitLimit is 5', eventCall?.limit === 5)
  check('search: per-session request reuses the same event filters', deepEqual(eventCall?.filters, expectedFilters))
  check('search: per-session request targets the session and query', eventCall?.sessionId === 's1' && eventCall?.query === 'alpha')
  check(
    'search: titles are fetched once for the page',
    fake.calls.readTitleSnapshots.length === 1 && deepEqual(fake.calls.readTitleSnapshots[0].sessionIds, ['s1']),
  )
  checkLossless('search: multi-turn response is lossless JSON', response)
}

{
  const fake = createSessionQuery()
  const { service } = loadPlugin(fake)
  let error
  try {
    await service.search({ query: '   \t ' })
  } catch (caught) {
    error = caught
  }
  check('search: blank query rejects with the contract message', error instanceof Error && error.message === '搜索关键词不能为空。', String(error))
  check('search: blank query never reaches the provider', fake.calls.searchSessions.length === 0)
  let missingError
  try {
    await service.search(undefined)
  } catch (caught) {
    missingError = caught
  }
  check('search: missing request rejects like a blank query', missingError instanceof Error && missingError.message === '搜索关键词不能为空。')
}

{
  const headers = new Map([
    ['s1', headerOf('s1', '/workspace/alpha')],
    ['s2', headerOf('s2', '/workspace/beta')],
    ['s3', headerOf('s3', '')],
    ['s4', headerOf('s4', '/workspace/alpha')],
    ['s5', headerOf('s5', '/workspace/alpha')],
  ])
  const items = [
    searchItemOf(recordOf('s1', '/workspace/alpha'), hitOf('s1', 3)),
    searchItemOf(recordOf('s2', '/workspace/beta'), hitOf('s2', 4)),
    searchItemOf(recordOf('s3', ''), hitOf('s3', 2)),
    searchItemOf(recordOf('s4', '/workspace/alpha'), hitOf('s4', 5, { type: 'session/title' })),
    searchItemOf(recordOf('s5', '/workspace/alpha'), hitOf('s5', 6, { surface: 'shadowed' })),
  ]
  const fake = createSessionQuery({
    searchSessions: () => ({ items }),
    searchEvents: (request) => ({ session: headers.get(request.sessionId), items: [hitOf(request.sessionId, 1)] }),
    readTitleSnapshots: (sessionIds) => sessionIds.map((sessionId) => titleObservation(headers.get(sessionId), `Title ${sessionId}`)),
  })
  const { service } = loadPlugin(fake)
  const response = await service.search({ query: 'needle' })
  check('search: keeps only workspace message sessions in provider order', response.sessions.map((group) => group.sessionId).join(',') === 's1,s2')
  check('search: titles align with session order', response.sessions.map((group) => group.title).join(',') === 'Title s1,Title s2')
  check('search: title snapshot requested once in order', deepEqual(fake.calls.readTitleSnapshots[0]?.sessionIds, ['s1', 's2']))
  const eventSessionIds = fake.calls.searchEvents.map((call) => call.request.sessionId).sort()
  check('search: per-session fan-out covers only kept sessions', deepEqual(eventSessionIds, ['s1', 's2']))

  const scoped = await service.search({ query: 'needle', cwd: '/workspace/beta' })
  check('search: exact cwd filter keeps one session', scoped.sessions.length === 1 && scoped.sessions[0].sessionId === 's2')
  checkLossless('search: cwd-filtered page is lossless JSON', scoped)
  const missing = await service.search({ query: 'needle', cwd: '/workspace/missing' })
  check('search: unmatched cwd yields an empty page', missing.sessions.length === 0 && missing.hasMore === false)
}

{
  const header1 = headerOf('s1', '/workspace/a')
  const header2 = headerOf('s2', '/workspace/b')
  const best1 = hitOf('s1', 9, { type: 'assistant/message', snippet: 'fallback text' })
  const fake = createSessionQuery({
    searchSessions: () => ({
      items: [searchItemOf(recordOf('s1', '/workspace/a'), best1), searchItemOf(recordOf('s2', '/workspace/b'), hitOf('s2', 2))],
    }),
    searchEvents: (request) => {
      if (request.sessionId === 's1') throw new Error('index exploded')
      return { session: header2, items: [hitOf('s2', 4), hitOf('s2', 2)] }
    },
    readTitleSnapshots: (sessionIds) => sessionIds.map((sessionId) => ({ status: 'rejected', reason: new Error(`no title for ${sessionId}`) })),
  })
  const { service } = loadPlugin(fake)
  const response = await service.search({ query: 'boom' })
  check('search: one failing session does not fail the page', response.sessions.length === 2)
  const failed = response.sessions[0]
  check(
    'search: failed session falls back to its bestMatch',
    failed.hits.length === 1 && failed.hits[0].seq === 9 && failed.hits[0].snippet === 'fallback text',
  )
  const healthy = response.sessions[1]
  check('search: healthy session keeps all its hits', healthy.hits.length === 2 && healthy.hits.map((hit) => hit.seq).join(',') === '4,2')
  check('search: rejected title snapshots project null', failed.title === null && healthy.title === null)
  checkLossless('search: fallback-page response is lossless JSON', response)
}

{
  const header = headerOf('s1', '/workspace/a')
  const fake = createSessionQuery({
    searchSessions: (request) => ({
      items: [searchItemOf(recordOf('s1', '/workspace/a'), hitOf('s1', 2))],
      ...(request.cursor === undefined ? {} : { nextCursor: 'cursor-2' }),
    }),
    searchEvents: () => ({ session: header, items: [hitOf('s1', 2)] }),
  })
  const { service } = loadPlugin(fake)
  const response = await service.search({ query: 'paged', cursor: 'cursor-1' })
  check('search: cursor forwarded to the provider untouched', fake.calls.searchSessions[0]?.request.cursor === 'cursor-1')
  check('search: provider nextCursor becomes hasMore + nextCursor', response.hasMore === true && response.nextCursor === 'cursor-2')
  check('search: missing title snapshot projects null', response.sessions[0]?.title === null && response.sessions[0]?.hits.length === 1)
  checkLossless('search: cursor page is lossless JSON', response)
  const firstPage = await service.search({ query: 'paged' })
  check('search: final page has hasMore false and no nextCursor', firstPage.hasMore === false && !Object.hasOwn(firstPage, 'nextCursor'))
}

{
  const header = headerOf('s1', '/workspace/a')
  const fake = createSessionQuery({
    searchSessions: () => ({ items: [searchItemOf(recordOf('s1', '/workspace/a'), hitOf('s1', 1))] }),
    searchEvents: () => ({ session: header, items: [hitOf('s1', 1)] }),
  })
  const { service } = loadPlugin(fake)
  await service.search({ query: 'q', sessionLimit: 999, hitLimit: 0 })
  check('search: sessionLimit clamped down to 100', fake.calls.searchSessions[0]?.request.limit === 100)
  check('search: hitLimit clamped up to 1', fake.calls.searchEvents[0]?.request.limit === 1)
  await service.search({ query: 'q', sessionLimit: 0, hitLimit: 999 })
  check('search: sessionLimit clamped up to 1', fake.calls.searchSessions[1]?.request.limit === 1)
  check('search: hitLimit clamped down to 20', fake.calls.searchEvents[1]?.request.limit === 20)
  await service.search({ query: 'q' })
  check(
    'search: defaults are sessionLimit 30 / hitLimit 5',
    fake.calls.searchSessions[2]?.request.limit === 30 && fake.calls.searchEvents[2]?.request.limit === 5,
  )
}

{
  const disabled = Object.assign(new Error('session search is disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  const fake = createSessionQuery({
    searchSessions: () => {
      throw disabled
    },
  })
  const { service } = loadPlugin(fake)
  let error
  try {
    await service.search({ query: 'q' })
  } catch (caught) {
    error = caught
  }
  check(
    'search: disabled index maps to the actionable user message',
    error instanceof Error &&
      error.message ===
        '会话全文索引未启用：请在 profile 的 cordis.patch.yml 中把 session-query-sqlite 的 openAt 设为 first-search。',
    String(error),
  )
}

{
  const boom = new Error('provider exploded')
  const fake = createSessionQuery({
    searchSessions: () => {
      throw boom
    },
  })
  const { service } = loadPlugin(fake)
  let error
  try {
    await service.search({ query: 'q' })
  } catch (caught) {
    error = caught
  }
  check('search: unrelated provider errors keep their identity', error === boom)
}

// ------------------------------------------------------------------ recent()

process.stdout.write('\n— recent() —\n')

{
  const records = [
    recordOf('s3', '/workspace/c', { live: false, persisted: true }),
    recordOf('s2', '', { live: true }),
    recordOf('s1', '/workspace/a', { live: true, parentSession: 'root-1' }),
  ]
  const byId = new Map(records.map((record) => [record.header.id, record.header]))
  const fake = createSessionQuery({
    listSessions: () => records,
    readTitleSnapshots: (sessionIds) =>
      sessionIds.map((sessionId, index) =>
        index === 0 ? { status: 'rejected', reason: new Error('cold session') } : titleObservation(byId.get(sessionId), `Title ${sessionId}`),
      ),
  })
  const { service } = loadPlugin(fake)
  const response = await service.recent({})
  check('recent: workspace sessions in newest-first provider order', response.sessions.map((session) => session.sessionId).join(',') === 's3,s1')
  check('recent: rejected title snapshot projects null', response.sessions[0]?.title === null)
  check('recent: fulfilled title snapshot folds the text', response.sessions[1]?.title === 'Title s1')
  check(
    'recent: live flag and optional parentSessionId',
    response.sessions[0]?.live === false &&
      !Object.hasOwn(response.sessions[0], 'parentSessionId') &&
      response.sessions[1]?.parentSessionId === 'root-1',
  )
  check('recent: listSessions called once', fake.calls.listSessions === 1)
  check('recent: title ids requested in presentation order', deepEqual(fake.calls.readTitleSnapshots[0]?.sessionIds, ['s3', 's1']))
  check(
    'recent: rows expose only the summary fields',
    response.sessions.every((session) =>
      Object.keys(session).every((key) => ['sessionId', 'title', 'cwd', 'createdAt', 'live', 'parentSessionId'].includes(key)),
    ),
  )
  checkLossless('recent: response is lossless JSON', response)

  const scoped = await service.recent({ cwd: '/workspace/a' })
  check('recent: exact cwd filter keeps one session', scoped.sessions.length === 1 && scoped.sessions[0]?.sessionId === 's1')
}

{
  const records = []
  for (let index = 0; index < 60; index += 1) records.push(recordOf(`s${index}`, `/workspace/${index}`))
  const fake = createSessionQuery({
    listSessions: () => records,
    readTitleSnapshots: (sessionIds) => sessionIds.map((sessionId) => ({ status: 'fulfilled', value: { session: { id: sessionId } } })),
  })
  const { service } = loadPlugin(fake)
  const defaults = await service.recent({})
  check('recent: default limit is 20', defaults.sessions.length === 20)
  const high = await service.recent({ limit: 999 })
  check('recent: limit clamped down to 50', high.sessions.length === 50)
  const zero = await service.recent({ limit: 0 })
  check('recent: limit clamped up to 1', zero.sessions.length === 1)
  const scoped = await service.recent({ limit: 5, cwd: '/workspace/7' })
  check('recent: limit applies after the cwd filter', scoped.sessions.length === 1 && scoped.sessions[0]?.sessionId === 's7')
  check('recent: no title snapshot means null title', defaults.sessions.every((session) => session.title === null))
}

{
  const fake = createSessionQuery({
    listSessions: () => [recordOf('s1', '/workspace/a')],
    readTitleSnapshots: () => {
      throw new Error('title pipeline down')
    },
  })
  const { service } = loadPlugin(fake)
  const response = await service.recent({})
  check('recent: whole-batch title failure degrades to null', response.sessions.length === 1 && response.sessions[0]?.title === null)
}

// ------------------------------------- optional real-Gateway integration probe

process.stdout.write('\n— integration (optional) —\n')

async function loadProtocolModule() {
  const candidates = [
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js'),
    '/tmp/dsh-probe/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js',
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (typeof module.remoteMethods === 'function') return { module, path: candidate }
    } catch (error) {
      process.stdout.write(`… could not import ${candidate}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return null
}

const probeRoot = '/tmp/dsh-probe/node_modules/@deepseek-ai'
const probePaths = {
  cordis: join(probeRoot, 'cordis', 'lib', 'index.js'),
  typertRegistry: join(probeRoot, 'dsh-typert-registry', 'lib', 'index.js'),
  gateway: join(probeRoot, 'dsh-api-gateway', 'lib', 'index.js'),
}
if (!Object.values(probePaths).every((path) => existsSync(path))) {
  process.stdout.write('… /tmp/dsh-probe is absent on this machine; skipping the in-process Gateway probe\n')
} else {
  let app
  try {
    const { Context } = await import(pathToFileURL(probePaths.cordis).href)
    const registryModule = await import(pathToFileURL(probePaths.typertRegistry).href)
    const gatewayModule = await import(pathToFileURL(probePaths.gateway).href)
    const typertRegistry = registryModule.default ?? registryModule
    const gateway = gatewayModule.default ?? gatewayModule
    const header = headerOf('idle-1', '/workspace/integration')
    const best = hitOf('idle-1', 4)
    const fake = createSessionQuery({
      searchSessions: () => ({ items: [searchItemOf(recordOf('idle-1', '/workspace/integration'), best)] }),
      searchEvents: () => ({ session: header, items: [hitOf('idle-1', 4), hitOf('idle-1', 2, { type: 'assistant/message' })] }),
      readTitleSnapshots: () => [titleObservation(header, 'Integration')],
      listSessions: () => [recordOf('idle-1', '/workspace/integration')],
    })
    app = new Context()
    app.provide('remoteAccess', { decide: () => ({ kind: 'allow' }), allows: () => true })
    await app.plugin(typertRegistry)
    await app.plugin(gateway)
    app.provide('sessionQuery', fake)
    await app.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
    const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer' }
    const result = await app.typertGateway.invoke({
      namespace: 'workspaceSessionSearch',
      method: 'search',
      args: { request: { query: 'integration' } },
      peer,
    })
    check(
      'integration: real Typert Gateway discovers and invokes search',
      result !== null && typeof result === 'object' && result.query === 'integration' && result.sessions?.length === 1,
      JSON.stringify(result),
    )
    check(
      'integration: gateway returns grouped multi-turn hits',
      result?.sessions?.[0]?.hits?.length === 2 && result.sessions[0].title === 'Integration',
      JSON.stringify(result),
    )
    check('integration: gateway result is lossless JSON', losslessProblem(result) === null, losslessProblem(result) ?? '')
    const recentResult = await app.typertGateway.invoke({
      namespace: 'workspaceSessionSearch',
      method: 'recent',
      args: { request: {} },
      peer,
    })
    check(
      'integration: real Typert Gateway invokes recent',
      recentResult !== null && typeof recentResult === 'object' && recentResult.sessions?.length === 1,
      JSON.stringify(recentResult),
    )
  } catch (error) {
    check('integration: in-process Typert Gateway probe', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    if (app !== undefined) {
      try {
        await app.fiber.dispose()
      } catch {
        // Teardown failure must not mask the probe result.
      }
    }
  }
}

// ------------------------------------------------------------------- summary

const failed = failures.length
process.stdout.write(`\n${checks - failed}/${checks} checks passed${failed === 0 ? '' : `, ${failed} failed`}\n`)
if (failed > 0) {
  for (const label of failures) process.stdout.write(`  ✖ ${label}\n`)
  process.stdout.write('HOST TESTS FAILED\n')
  process.exitCode = 1
} else {
  process.stdout.write('HOST TESTS PASSED\n')
}
