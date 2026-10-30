/**
 * Wire contract shared by the two halves.
 *
 * The host half is plain ESM JavaScript, so it cannot import this module; the
 * shapes and constants here are the single reference both halves follow. Keep
 * the host's JSDoc annotations in sync with these types.
 */

/** Cordis service key and Typert Remote namespace of the host half. */
export const SERVICE_KEY = 'workspaceSessionSearch'
export const REMOTE_NAMESPACE = 'workspaceSessionSearch'

/** Sidebar panellist id, also the `main` keyed slot key. */
export const PANEL_ID = 'session-search'

/** Locale namespace of the plugin's own dictionaries. */
export const NS = 'dshWorkspaceSessionSearch'

/** Message event types that count as conversation turns. */
export const MESSAGE_TYPES = ['user/message', 'assistant/message'] as const
export type MessageEventType = (typeof MESSAGE_TYPES)[number]

/** One matching message inside a session. */
export interface SessionSearchHit {
  seq: number
  type: MessageEventType
  time: number
  snippet: string
}

/** One session with its matching turns. */
export interface SessionSearchGroup {
  sessionId: string
  title: string | null
  cwd: string
  createdAt: number
  parentSessionId?: string
  live: boolean
  /** Up to `hitLimit` matching turns, strongest match first. */
  hits: SessionSearchHit[]
  /** The strongest match in the session, used for snippets/counts. */
  bestMatch: SessionSearchHit
}

export interface SearchRequest {
  /** Required literal query; surrounding whitespace is trimmed. */
  query: string
  /** Candidate sessions per page. Default 30, clamped to 1..100. */
  sessionLimit?: number
  /** Matching turns returned per session. Default 5, clamped to 1..20. */
  hitLimit?: number
  /** Opaque continuation cursor from a previous response. */
  cursor?: string
  /** Optional exact `cwd` scope filter. */
  cwd?: string
}

export interface SearchResponse {
  query: string
  sessions: SessionSearchGroup[]
  hasMore: boolean
  nextCursor?: string
}

export interface RecentRequest {
  /** Default 20, clamped to 1..50. */
  limit?: number
  cwd?: string
}

export interface SessionSummary {
  sessionId: string
  title: string | null
  cwd: string
  createdAt: number
  parentSessionId?: string
  live: boolean
}

export interface RecentResponse {
  sessions: SessionSummary[]
}

export interface RemoteFailure {
  code: string
  message: string
}

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/** Request used by the client for both Remote methods: `{ args: { request } }`. */
export interface RemoteEnvelope<T> {
  args: { request: T }
}
