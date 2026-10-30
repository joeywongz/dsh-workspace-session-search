/**
 * Host half of `dsh-workspace-session-search`.
 *
 * Plain ESM JavaScript with **zero imports**: the plugin registers the
 * `workspaceSessionSearch` Cordis service and exposes it through the Typert
 * Gateway's source-mode ("SRC") Remote discovery. Third-party plugins have no
 * generated Typert artifacts, so the binding and the Remote method markers are
 * written by hand exactly as `@deepseek-ai/dsh-typert-protocol` would:
 *
 *   service.typertRemote = { service, serviceKey, namespace }
 *   Service.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods']
 *     = { version: 1, methods: [{ method: 'search', invocation: { kind: 'direct' } }, ...] }
 *
 * The gateway discovers these markers (`collectSrcClaims`) and dispatches
 * `POST /api/<namespace>/<method>` with `{ args: { request } }`, reading the
 * parameter names from `Function.prototype.toString` — so the method parameter
 * lists below are part of the wire contract and must stay plain identifiers.
 *
 * The public shapes mirror `src/shared/contract.ts`; responses are lossless
 * JSON (no `undefined`, `BigInt`, `NaN`, `-0`, class instances, or functions).
 */

/** Cordis service key. */
const SERVICE_KEY = 'workspaceSessionSearch'
/** Typert Remote namespace; also the `/api/<namespace>/<method>` segment. */
const REMOTE_NAMESPACE = 'workspaceSessionSearch'
/** Prototype property carrying the hand-written Remote method descriptor. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Message event types that count as conversation turns. */
const MESSAGE_TYPES = Object.freeze(['user/message', 'assistant/message'])
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES)

/** Defaults and bounds of the two request contracts. */
const DEFAULT_SESSION_LIMIT = 30
const MIN_SESSION_LIMIT = 1
const MAX_SESSION_LIMIT = 100
const DEFAULT_HIT_LIMIT = 5
const MIN_HIT_LIMIT = 1
const MAX_HIT_LIMIT = 20
const DEFAULT_RECENT_LIMIT = 20
const MIN_RECENT_LIMIT = 1
const MAX_RECENT_LIMIT = 50

/** Per-session `searchEvents` fan-out bound. */
const SEARCH_CONCURRENCY = 4

const EMPTY_QUERY_MESSAGE = '搜索关键词不能为空。'
const SEARCH_DISABLED_MESSAGE =
  '会话全文索引未启用：请在 profile 的 cordis.patch.yml 中把 session-query-sqlite 的 openAt 设为 first-search。'

/**
 * Event metadata filters shared by the cross-session and within-session search
 * calls: only current-surface conversation turns are indexed as hits.
 * @returns fresh filter array for one provider request.
 */
function messageEventFilters() {
  return [
    { kind: 'type', values: [...MESSAGE_TYPES] },
    { kind: 'surface', values: ['current'] },
  ]
}

/**
 * Clamp one numeric request field into an inclusive range.
 * @param value - caller-provided value.
 * @param fallback - default used when the value is absent or not numeric.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns integer within `[min, max]`.
 */
function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const truncated = Math.trunc(numeric)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/**
 * Coerce one numeric field to a lossless JSON number.
 * @param value - candidate provider number.
 * @returns the finite number, or `0` for absent/non-finite/negative-zero input.
 */
function numberOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) return 0
  return value
}

/**
 * Normalize one provider event hit into the wire hit shape.
 * @param hit - `bestMatch` or `searchEvents` item from the provider.
 * @returns wire hit, or `null` when it is not a current-surface message event.
 */
function wireHitOf(hit) {
  if (hit === null || typeof hit !== 'object') return null
  if (!MESSAGE_TYPE_SET.has(hit.type)) return null
  if (hit.surface !== 'current') return null
  return {
    seq: numberOf(hit.seq),
    type: hit.type,
    time: numberOf(hit.time),
    snippet: typeof hit.snippet === 'string' ? hit.snippet : '',
  }
}

/**
 * Keep one cross-session search candidate when it belongs to a workspace and
 * carries a usable message `bestMatch`.
 * @param candidate - provider `SessionSearchHit`.
 * @param cwdFilter - optional exact workspace filter (`''` means none).
 * @returns normalized candidate, or `null` when it must be dropped.
 */
function candidateOf(candidate, cwdFilter) {
  if (candidate === null || typeof candidate !== 'object') return null
  const header = candidate.header
  if (header === null || typeof header !== 'object') return null
  if (typeof header.id !== 'string' || header.id === '') return null
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  if (cwd === '') return null
  if (cwdFilter !== '' && cwd !== cwdFilter) return null
  const bestMatch = wireHitOf(candidate.bestMatch)
  if (bestMatch === null) return null
  return { header, live: candidate.live === true, bestMatch }
}

/**
 * Read the plain title text from one `readTitleSnapshots` projection value.
 * @param value - `{ session, title?: SessionTitleSnapshot }`.
 * @returns non-empty title text, or `null`.
 */
function titleOf(value) {
  if (value === null || typeof value !== 'object') return null
  const snapshot = value.title
  const text =
    typeof snapshot === 'string'
      ? snapshot
      : snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string'
        ? snapshot.title
        : ''
  return text === '' ? null : text
}

/**
 * Fold title snapshots into `sessionId -> title` for the current page.
 * A whole-batch failure or one rejected snapshot degrades to `null` titles.
 * @param queryService - `ctx.sessionQuery`.
 * @param sessionIds - page session ids in presentation order.
 * @returns title map; absent ids mean `null`.
 */
async function readTitles(queryService, sessionIds) {
  const titles = new Map()
  if (sessionIds.length === 0) return titles
  let results
  try {
    results = await queryService.readTitleSnapshots(sessionIds)
  } catch {
    return titles
  }
  if (!Array.isArray(results)) return titles
  for (const result of results) {
    if (result === null || typeof result !== 'object') continue
    if (result.status !== 'fulfilled') continue
    const value = result.value
    const sessionId = value !== null && typeof value === 'object' && value.session !== null && typeof value.session === 'object' ? value.session.id : undefined
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const title = titleOf(value)
    if (title !== null) titles.set(sessionId, title)
  }
  return titles
}

/**
 * Run `worker` over `items` with a fixed number of concurrent lanes while
 * preserving input order in the result array.
 * @param items - ordered work items.
 * @param concurrency - maximum parallel lanes.
 * @param worker - async per-item work.
 * @returns results in input order.
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  const lanes = []
  const laneCount = Math.min(concurrency, items.length)
  for (let index = 0; index < laneCount; index += 1) lanes.push(lane())
  await Promise.all(lanes)
  return results
}

/**
 * Build the session summary shared by `search` groups and `recent` rows.
 * @param header - provider session header.
 * @param live - current liveness flag.
 * @param title - folded title or `null`.
 * @returns lossless JSON session summary.
 */
function sessionSummaryOf(header, live, title) {
  const summary = {
    sessionId: header.id,
    title,
    cwd: header.cwd,
    createdAt: numberOf(header.createdAt),
    live,
  }
  if (typeof header.parentSession === 'string' && header.parentSession !== '') {
    summary.parentSessionId = header.parentSession
  }
  return summary
}

/**
 * Map a provider failure onto the wire error contract.
 * @param error - failure thrown by the session-query provider.
 * @returns the user-facing error to throw.
 */
function searchErrorOf(error) {
  if (error !== null && typeof error === 'object' && error.code === 'SESSION_QUERY_SEARCH_DISABLED') {
    return new Error(SEARCH_DISABLED_MESSAGE)
  }
  return error
}

/**
 * `ctx.provide('workspaceSessionSearch', …)` implementation with two SRC
 * Remote methods. Instances are plain objects: the gateway calls the prototype
 * methods with the service as `this`, so `this.ctx` resolves the session-query
 * service.
 */
class WorkspaceSessionSearchService {
  /**
   * @param ctx - owning Cordis context (must inject `sessionQuery`).
   */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * Full-text search every workspace session, returning grouped matching turns.
   * Parameter list is part of the wire contract: exactly `(request)`.
   * @param request - `{ query, sessionLimit?, hitLimit?, cursor?, cwd? }`.
   * @returns `{ query, sessions, hasMore, nextCursor? }`.
   */
  async search(request) {
    const input = request !== null && typeof request === 'object' ? request : {}
    const query = String(input.query ?? '').trim()
    if (query === '') throw new Error(EMPTY_QUERY_MESSAGE)
    const sessionLimit = clampInteger(input.sessionLimit, DEFAULT_SESSION_LIMIT, MIN_SESSION_LIMIT, MAX_SESSION_LIMIT)
    const hitLimit = clampInteger(input.hitLimit, DEFAULT_HIT_LIMIT, MIN_HIT_LIMIT, MAX_HIT_LIMIT)
    const cwdFilter = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : ''
    const cursor = typeof input.cursor === 'string' && input.cursor !== '' ? input.cursor : undefined
    const queryService = this.ctx.sessionQuery
    try {
      const page = await queryService.searchSessions({
        query,
        limit: sessionLimit,
        eventFilters: messageEventFilters(),
        ...(cursor === undefined ? {} : { cursor }),
      })
      const candidates = Array.isArray(page === null || page === undefined ? undefined : page.items) ? page.items : []
      const kept = []
      for (const candidate of candidates) {
        const normalized = candidateOf(candidate, cwdFilter)
        if (normalized !== null) kept.push(normalized)
      }
      const hitsBySession = await mapWithConcurrency(kept, SEARCH_CONCURRENCY, async (candidate) => {
        let hits = []
        try {
          const eventPage = await queryService.searchEvents({
            sessionId: candidate.header.id,
            query,
            limit: hitLimit,
            filters: messageEventFilters(),
          })
          const items = Array.isArray(eventPage === null || eventPage === undefined ? undefined : eventPage.items) ? eventPage.items : []
          hits = items.map(wireHitOf).filter((hit) => hit !== null)
        } catch {
          hits = []
        }
        // A per-session failure degrades to the strongest match instead of
        // failing the whole page.
        return hits.length === 0 ? [candidate.bestMatch] : hits
      })
      const titles = await readTitles(queryService, kept.map((candidate) => candidate.header.id))
      const sessions = kept.map((candidate, index) => {
        const group = sessionSummaryOf(candidate.header, candidate.live, titles.get(candidate.header.id) ?? null)
        group.hits = hitsBySession[index]
        group.bestMatch = candidate.bestMatch
        return group
      })
      const nextCursor =
        page !== null && page !== undefined && typeof page.nextCursor === 'string' && page.nextCursor !== ''
          ? page.nextCursor
          : undefined
      return {
        query,
        sessions,
        hasMore: nextCursor !== undefined,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }
    } catch (error) {
      throw searchErrorOf(error)
    }
  }

  /**
   * List the newest workspace sessions for the panel's idle state.
   * Parameter list is part of the wire contract: exactly `(request)`.
   * @param request - `{ limit?, cwd? }`.
   * @returns `{ sessions }`.
   */
  async recent(request) {
    const input = request !== null && typeof request === 'object' ? request : {}
    const limit = clampInteger(input.limit, DEFAULT_RECENT_LIMIT, MIN_RECENT_LIMIT, MAX_RECENT_LIMIT)
    const cwdFilter = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : ''
    const queryService = this.ctx.sessionQuery
    const records = await queryService.listSessions()
    const kept = []
    for (const record of Array.isArray(records) ? records : []) {
      if (record === null || typeof record !== 'object') continue
      const header = record.header
      if (header === null || typeof header !== 'object') continue
      if (typeof header.id !== 'string' || header.id === '') continue
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      if (cwd === '') continue
      if (cwdFilter !== '' && cwd !== cwdFilter) continue
      kept.push(record)
      if (kept.length >= limit) break
    }
    const titles = await readTitles(queryService, kept.map((record) => record.header.id))
    return {
      sessions: kept.map((record) =>
        sessionSummaryOf(record.header, record.live === true, titles.get(record.header.id) ?? null),
      ),
    }
  }
}

// Source-mode Remote markers: hand-written `remoteMethods()` descriptor, read
// by the gateway from the service's class prototype.
Object.defineProperty(WorkspaceSessionSearchService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'search', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'recent', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

/** Cordis plugin identity. */
export const name = 'workspace-session-search'
/** The root session-query service must be present before this plugin loads. */
export const inject = ['sessionQuery']

/**
 * Register the service and its Gateway binding.
 * @param ctx - Cordis context that provides `sessionQuery`.
 * @returns nothing; the service is unregistered with the owning fiber.
 */
export function apply(ctx) {
  const service = new WorkspaceSessionSearchService(ctx)
  service.typertRemote = Object.freeze({
    service,
    serviceKey: SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
  })
  ctx.provide(SERVICE_KEY, service)
}
