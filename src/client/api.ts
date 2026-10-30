/**
 * Typed access to the host half over the Connection unary RPC carrier.
 *
 * The host exposes the `workspaceSessionSearch` Typert namespace through
 * source-mode Remote dispatch, so the client calls the same `/api` endpoint the
 * generated Remote front ends use, without a generated contribution:
 *   POST /api/workspaceSessionSearch/<method>  { args: { request } }
 */

import {
  REMOTE_NAMESPACE,
  type RecentRequest,
  type RecentResponse,
  type RemoteFailure,
  type RemoteResult,
  type SearchRequest,
  type SearchResponse,
  type SessionSearchGroup,
  type SessionSearchHit,
  type SessionSummary,
} from '../shared/contract'
import type { ClientContext, ConnectionApi } from './types'

/** A failure reported by the host Remote (or a transport/carrier failure). */
export class SearchApiError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SearchApiError'
    this.code = code
  }
}

export interface SearchApi {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>
  recent(request: RecentRequest, signal?: AbortSignal): Promise<RecentResponse>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function connectionOf(ctx: ClientContext): ConnectionApi | null {
  const direct = ctx.get('connection')
  if (isRecord(direct) && isRecord(direct.rpc)) return direct as unknown as ConnectionApi
  const record = ctx as unknown as Record<string, unknown>
  if (isRecord(record.connection) && isRecord((record.connection as Record<string, unknown>).rpc)) {
    return record.connection as unknown as ConnectionApi
  }
  return null
}

function failureOf(result: RemoteResult<unknown>): RemoteFailure {
  if (result.ok) return { code: 'remote/unexpected', message: 'Unexpected success result' }
  const failure = result.error
  return {
    code: typeof failure?.code === 'string' ? failure.code : 'remote/unknown',
    message: typeof failure?.message === 'string' ? failure.message : 'Remote call failed',
  }
}

async function call<T>(
  connection: ConnectionApi | null,
  method: 'search' | 'recent',
  request: SearchRequest | RecentRequest,
  signal?: AbortSignal,
): Promise<T> {
  if (!connection) throw new SearchApiError('remote/unavailable', 'Host connection service is not available.')
  let result: RemoteResult<unknown>
  try {
    result = await connection.rpc.call('/api', `${REMOTE_NAMESPACE}/${method}`, { args: { request } }, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    throw new SearchApiError('remote/transport', error instanceof Error ? error.message : String(error))
  }
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    throw new SearchApiError('remote/malformed', 'Host returned a malformed Remote result.')
  }
  if (!result.ok) {
    const failure = failureOf(result)
    throw new SearchApiError(failure.code, failure.message)
  }
  return result.value as T
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeHit(value: unknown): SessionSearchHit | null {
  if (!isRecord(value)) return null
  const type = value.type === 'user/message' || value.type === 'assistant/message' ? value.type : null
  if (type === null) return null
  return {
    seq: numberOf(value.seq),
    type,
    time: numberOf(value.time),
    snippet: stringOf(value.snippet),
  }
}

function normalizeGroup(value: unknown): SessionSearchGroup | null {
  if (!isRecord(value)) return null
  const sessionId = stringOf(value.sessionId)
  if (sessionId === '') return null
  const hits = Array.isArray(value.hits) ? value.hits.map(normalizeHit).filter((hit): hit is SessionSearchHit => hit !== null) : []
  const best = normalizeHit(value.bestMatch) ?? hits[0]
  if (!best) return null
  return {
    sessionId,
    title: typeof value.title === 'string' && value.title.trim() !== '' ? value.title : null,
    cwd: stringOf(value.cwd),
    createdAt: numberOf(value.createdAt),
    ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
    live: value.live === true,
    hits,
    bestMatch: best,
  }
}

function normalizeSearch(value: unknown): SearchResponse {
  if (!isRecord(value)) throw new SearchApiError('remote/malformed', 'Host returned a malformed search payload.')
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map(normalizeGroup).filter((group): group is SessionSearchGroup => group !== null)
    : []
  return {
    query: stringOf(value.query),
    sessions,
    hasMore: value.hasMore === true,
    ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
  }
}

function normalizeSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null
  const sessionId = stringOf(value.sessionId)
  if (sessionId === '') return null
  return {
    sessionId,
    title: typeof value.title === 'string' && value.title.trim() !== '' ? value.title : null,
    cwd: stringOf(value.cwd),
    createdAt: numberOf(value.createdAt),
    ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
    live: value.live === true,
  }
}

function normalizeRecent(value: unknown): RecentResponse {
  if (!isRecord(value)) throw new SearchApiError('remote/malformed', 'Host returned a malformed recent payload.')
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map(normalizeSummary).filter((session): session is SessionSummary => session !== null)
    : []
  return { sessions }
}

/** Build the API facade bound to one client context. */
export function createSearchApi(ctx: ClientContext): SearchApi {
  return {
    async search(request, signal) {
      return normalizeSearch(await call<unknown>(connectionOf(ctx), 'search', request, signal))
    },
    async recent(request, signal) {
      return normalizeRecent(await call<unknown>(connectionOf(ctx), 'recent', request, signal))
    },
  }
}
