/**
 * Sidebar "session search" panel.
 *
 * Renders the full-text search experience for every workspace session of the
 * current profile: the query field (Enter + 300 ms debounce + abort/stale
 * guards), the recent-session idle state, loading/empty/error states with a
 * retry path, and per-session groups that list every matching turn with the
 * query terms highlighted. All user-facing text comes from the injected `t`
 * (see `i18n.ts`); the component only uses the host React runtime.
 */

import React from 'react'
import { format } from './i18n'
import type {
  RecentResponse,
  SearchRequest,
  SearchResponse,
  SessionSearchGroup,
  SessionSearchHit,
} from '../shared/contract'
import type { PanelFace } from './types'

const SEARCH_DEBOUNCE_MS = 300
const SESSION_LIMIT = 30
const HIT_LIMIT = 5
const RECENT_LIMIT = 20

type Status = 'idle' | 'loading' | 'ready' | 'error'
type RecentStatus = 'loading' | 'ready' | 'error'

type Translate = PanelFace['t']

// ------------------------------------------------------------------ helpers

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function queryTokens(query: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const rawToken of query.trim().split(/\s+/)) {
    const token = rawToken.trim()
    if (token === '') continue
    const folded = token.toLowerCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    tokens.push(token)
  }
  // Longest first so overlapping tokens highlight the most specific match.
  tokens.sort((left, right) => right.length - left.length)
  return tokens
}

interface SnippetPart {
  text: string
  match: boolean
}

/** Split a snippet into plain/highlighted parts without injecting HTML. */
function highlightParts(snippet: string, query: string): SnippetPart[] {
  if (snippet === '') return []
  const tokens = queryTokens(query)
  if (tokens.length === 0) return [{ text: snippet, match: false }]
  const pattern = new RegExp('(' + tokens.map(escapeRegExp).join('|') + ')', 'gi')
  const pieces = snippet.split(pattern)
  const parts: SnippetPart[] = []
  for (let index = 0; index < pieces.length; index += 1) {
    const text = pieces[index]
    if (text === '') continue
    parts.push({ text, match: index % 2 === 1 })
  }
  return parts.length === 0 ? [{ text: snippet, match: false }] : parts
}

function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/g, '')
  if (trimmed === '') return cwd
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || trimmed
}

function latestTime(group: SessionSearchGroup): number {
  let latest = Number.isFinite(group.createdAt) ? group.createdAt : 0
  for (const hit of group.hits) {
    if (Number.isFinite(hit.time) && hit.time > latest) latest = hit.time
  }
  if (Number.isFinite(group.bestMatch.time) && group.bestMatch.time > latest) latest = group.bestMatch.time
  return latest
}

/** Locale-aware, dependency-free relative timestamp (falls back to a date). */
function relativeTime(t: Translate, timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return t('time.justNow')
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return format(t('time.minutesAgo'), { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return format(t('time.hoursAgo'), { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return format(t('time.daysAgo'), { count: days })
  try {
    return new Date(timestamp).toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

/** Map a thrown `SearchApiError` (or anything else) to readable text. */
function describeError(t: Translate, error: unknown): string {
  const record: { code?: unknown; message?: unknown } = typeof error === 'object' && error !== null ? error : {}
  const code = typeof record.code === 'string' ? record.code : ''
  const message =
    typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : ''
  if (code === 'remote/unavailable') return t('error.unavailable')
  if (
    code === 'SESSION_QUERY_SEARCH_DISABLED' ||
    message.includes('SESSION_QUERY_SEARCH_DISABLED') ||
    message.includes('全文索引')
  ) {
    return t('error.disabled')
  }
  return message !== '' ? message : t('search.error')
}

function hitRoleKey(hit: SessionSearchHit): 'hit.you' | 'hit.assistant' {
  return hit.type === 'user/message' ? 'hit.you' : 'hit.assistant'
}

/** Append a page onto the current response, merging groups with the same id. */
function mergeResponses(previous: SearchResponse, next: SearchResponse): SearchResponse {
  const groups = previous.sessions.map((group) => ({ ...group, hits: [...group.hits] }))
  const indexById = new Map<string, number>()
  groups.forEach((group, index) => indexById.set(group.sessionId, index))
  for (const incoming of next.sessions) {
    const existingIndex = indexById.get(incoming.sessionId)
    if (existingIndex === undefined) {
      indexById.set(incoming.sessionId, groups.length)
      groups.push({ ...incoming, hits: [...incoming.hits] })
      continue
    }
    const existing = groups[existingIndex]
    const seenSeqs = new Set(existing.hits.map((hit) => hit.seq))
    const mergedHits = [...existing.hits]
    for (const hit of incoming.hits) {
      if (seenSeqs.has(hit.seq)) continue
      seenSeqs.add(hit.seq)
      mergedHits.push(hit)
    }
    groups[existingIndex] = {
      ...existing,
      ...incoming,
      hits: mergedHits,
      bestMatch: incoming.bestMatch,
    }
  }
  const merged: SearchResponse = {
    query: next.query !== '' ? next.query : previous.query,
    sessions: groups,
    hasMore: next.hasMore,
  }
  if (typeof next.nextCursor === 'string') merged.nextCursor = next.nextCursor
  return merged
}

// -------------------------------------------------------------------- glyphs

function SearchGlyph(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

function ClearGlyph(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

// ---------------------------------------------------------------- fragments

function HighlightedSnippet(props: { text: string; query: string }): React.ReactElement {
  const parts = highlightParts(props.text, props.query)
  return (
    <span className="wss-snippet">
      {parts.map((part, index) =>
        part.match ? (
          <mark className="wss-mark" key={'mark-' + String(index)}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  )
}

function SearchHitRow(props: {
  sessionId: string
  hit: SessionSearchHit
  query: string
  t: Translate
  onOpen: (sessionId: string) => void
}): React.ReactElement {
  const { hit, t } = props
  const isUser = hit.type === 'user/message'
  return (
    <li className="wss-hitItem">
      <button
        type="button"
        className="wss-hit"
        title={t('session.open')}
        onClick={() => props.onOpen(props.sessionId)}
      >
        <span className={'wss-hitBadge ' + (isUser ? 'wss-hitBadge-you' : 'wss-hitBadge-assistant')}>
          {t(hitRoleKey(hit))}
        </span>
        <span className="wss-hitTime">{relativeTime(t, hit.time)}</span>
        <HighlightedSnippet text={hit.snippet} query={props.query} />
      </button>
    </li>
  )
}

function SessionGroupCard(props: {
  group: SessionSearchGroup
  query: string
  t: Translate
  onOpen: (sessionId: string) => void
}): React.ReactElement {
  const { group, t } = props
  const hitCount = format(t('session.hits'), { count: group.hits.length })
  return (
    <li className="wss-groupItem">
      <section
        className="wss-group"
        data-session-id={group.sessionId}
        aria-label={group.title ?? t('session.untitled')}
      >
        <button type="button" className="wss-groupHead" onClick={() => props.onOpen(group.sessionId)}>
          <span className="wss-groupTitleRow">
            <span className="wss-groupTitle">{group.title ?? t('session.untitled')}</span>
            <span className={'wss-liveBadge ' + (group.live ? 'wss-live' : 'wss-cold')}>
              {group.live ? t('session.live') : t('session.cold')}
            </span>
          </span>
          <span className="wss-groupMeta">
            {group.cwd !== '' ? (
              <span className="wss-workspace" title={group.cwd}>
                {workspaceName(group.cwd)}
              </span>
            ) : null}
            <span className="wss-time">{relativeTime(t, latestTime(group))}</span>
            <span className="wss-hitCount">{hitCount}</span>
          </span>
        </button>
        <ul className="wss-hits" aria-label={hitCount}>
          {group.hits.map((hit) => (
            <SearchHitRow
              key={group.sessionId + ':' + String(hit.seq)}
              sessionId={group.sessionId}
              hit={hit}
              query={props.query}
              t={t}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      </section>
    </li>
  )
}

function ErrorNote(props: {
  t: Translate
  title: string
  detail: string
  onRetry: () => void
}): React.ReactElement {
  return (
    <div className="wss-error" role="alert">
      <div className="wss-errorText">
        <p className="wss-errorTitle">{props.title}</p>
        {props.detail !== '' ? <p className="wss-errorDetail">{props.detail}</p> : null}
      </div>
      <button type="button" className="wss-retry" onClick={props.onRetry}>
        {props.t('search.retry')}
      </button>
    </div>
  )
}

function LoadingState(): React.ReactElement {
  return (
    <div className="wss-loading" aria-hidden="true">
      <div className="wss-skeleton" />
      <div className="wss-skeleton" />
    </div>
  )
}

function RecentSection(props: {
  t: Translate
  status: RecentStatus
  response: RecentResponse | null
  error: unknown
  onOpen: (sessionId: string) => void
  onRetry: () => void
}): React.ReactElement {
  const { t, response, status } = props
  const sessions = response ? response.sessions : []
  return (
    <section className="wss-recent" aria-label={t('recent.title')}>
      <h2 className="wss-sectionTitle">{t('recent.title')}</h2>
      {status === 'loading' ? <p className="wss-muted">{t('recent.loading')}</p> : null}
      {status === 'error' ? (
        <ErrorNote
          t={t}
          title={t('recent.error')}
          detail={describeError(t, props.error)}
          onRetry={props.onRetry}
        />
      ) : null}
      {status === 'ready' && sessions.length === 0 ? (
        <p className="wss-muted">{t('recent.empty')}</p>
      ) : null}
      {status === 'ready' && sessions.length > 0 ? (
        <ul className="wss-recentList">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className="wss-recentRow"
                title={session.cwd !== '' ? session.cwd : t('session.open')}
                onClick={() => props.onOpen(session.sessionId)}
              >
                <span className="wss-recentTitle">{session.title ?? t('session.untitled')}</span>
                <span className="wss-recentMeta">
                  {session.cwd !== '' ? (
                    <span className="wss-workspace" title={session.cwd}>
                      {workspaceName(session.cwd)}
                    </span>
                  ) : null}
                  <span className="wss-time">{relativeTime(t, session.createdAt)}</span>
                  <span className={'wss-liveBadge ' + (session.live ? 'wss-live' : 'wss-cold')}>
                    {session.live ? t('session.live') : t('session.cold')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

// -------------------------------------------------------------------- panel

export function SearchPanel(props: PanelFace): React.ReactElement {
  const t: Translate = typeof props.t === 'function' ? props.t : (key: string) => key

  const [inputValue, setInputValue] = React.useState('')
  const [status, setStatus] = React.useState<Status>('idle')
  const [submittedQuery, setSubmittedQuery] = React.useState('')
  const [result, setResult] = React.useState<SearchResponse | null>(null)
  const [error, setError] = React.useState<unknown>(null)
  const [appendError, setAppendError] = React.useState<unknown>(null)
  const [appending, setAppending] = React.useState(false)
  const [recent, setRecent] = React.useState<RecentResponse | null>(null)
  const [recentStatus, setRecentStatus] = React.useState<RecentStatus>('loading')
  const [recentError, setRecentError] = React.useState<unknown>(null)

  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchAbortRef = React.useRef<AbortController | null>(null)
  const recentAbortRef = React.useRef<AbortController | null>(null)
  const sequenceRef = React.useRef(0)
  const appendCursorRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    loadRecent()
    const element = inputRef.current
    if (element && typeof element.focus === 'function') {
      try {
        element.focus()
      } catch {
        /* focus is best-effort (the panel may not be visible yet) */
      }
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (searchAbortRef.current) searchAbortRef.current.abort()
      if (recentAbortRef.current) recentAbortRef.current.abort()
    }
  }, [])

  function clearTimer(): void {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function abortSearch(): void {
    if (searchAbortRef.current) {
      searchAbortRef.current.abort()
      searchAbortRef.current = null
    }
  }

  function loadRecent(): void {
    if (recentAbortRef.current) recentAbortRef.current.abort()
    const controller = new AbortController()
    recentAbortRef.current = controller
    setRecentStatus('loading')
    setRecentError(null)
    Promise.resolve()
      .then(() => props.recent({ limit: RECENT_LIMIT }, controller.signal))
      .then((response) => {
        if (controller.signal.aborted) return
        setRecent(response)
        setRecentStatus('ready')
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setRecentError(caught)
        setRecentStatus('error')
      })
  }

  function resetToIdle(): void {
    sequenceRef.current += 1
    appendCursorRef.current = null
    setStatus('idle')
    setSubmittedQuery('')
    setResult(null)
    setError(null)
    setAppendError(null)
    setAppending(false)
  }

  function scheduleSearch(value: string): void {
    clearTimer()
    const query = value.trim()
    if (query === '') {
      abortSearch()
      resetToIdle()
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runSearch(query)
    }, SEARCH_DEBOUNCE_MS)
  }

  function runSearch(rawQuery: string, cursor?: string): void {
    const query = rawQuery.trim()
    if (query === '') return
    abortSearch()
    const controller = new AbortController()
    searchAbortRef.current = controller
    sequenceRef.current += 1
    const sequence = sequenceRef.current
    const appendingMore = typeof cursor === 'string'
    setSubmittedQuery(query)
    setError(null)
    setAppendError(null)
    setAppending(appendingMore)
    if (!appendingMore) {
      setStatus('loading')
      setResult(null)
    }
    const request: SearchRequest = {
      query,
      sessionLimit: SESSION_LIMIT,
      hitLimit: HIT_LIMIT,
    }
    if (appendingMore) request.cursor = cursor
    Promise.resolve()
      .then(() => props.search(request, controller.signal))
      .then((response) => {
        if (sequence !== sequenceRef.current || controller.signal.aborted) return
        setResult((previous) => (appendingMore && previous ? mergeResponses(previous, response) : response))
        setStatus('ready')
        setAppending(false)
      })
      .catch((caught: unknown) => {
        if (sequence !== sequenceRef.current || controller.signal.aborted) return
        if (appendingMore) {
          setAppendError(caught)
          setStatus((previous) => (previous === 'ready' ? 'ready' : 'error'))
        } else {
          setError(caught)
          setStatus('error')
        }
        setAppending(false)
      })
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const value = event && event.target && typeof event.target.value === 'string' ? event.target.value : ''
    setInputValue(value)
    scheduleSearch(value)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    clearTimer()
    const query = inputValue.trim()
    if (query === '') {
      abortSearch()
      resetToIdle()
      return
    }
    runSearch(query)
  }

  function handleClear(): void {
    clearTimer()
    abortSearch()
    resetToIdle()
    setInputValue('')
    const element = inputRef.current
    if (element && typeof element.focus === 'function') {
      try {
        element.focus()
      } catch {
        /* ignore */
      }
    }
  }

  function loadMore(): void {
    if (appending || !result || !result.hasMore) return
    const cursor = result.nextCursor
    if (typeof cursor !== 'string' || cursor === '') return
    appendCursorRef.current = cursor
    runSearch(submittedQuery !== '' ? submittedQuery : inputValue, cursor)
  }

  function retrySearch(): void {
    const query = (submittedQuery !== '' ? submittedQuery : inputValue).trim()
    if (query === '') return
    runSearch(query)
  }

  function retryAppend(): void {
    const cursor = appendCursorRef.current
    const query = (submittedQuery !== '' ? submittedQuery : inputValue).trim()
    if (cursor === null || query === '') return
    runSearch(query, cursor)
  }

  let totalHits = 0
  if (result !== null) {
    for (const group of result.sessions) totalHits += group.hits.length
  }
  const hasResults = status === 'ready' && result !== null && result.sessions.length > 0

  return (
    <div className="wss-panel">
      <div className="wss-content">
        <header className="wss-header">
          <h1 className="wss-title">{t('panel.title')}</h1>
          <p className="wss-subtitle">{t('panel.subtitle')}</p>
        </header>

        <form className="wss-searchForm" role="search" aria-label={t('panel.title')} onSubmit={handleSubmit}>
          <div className="wss-searchBox">
            <span className="wss-searchGlyph" aria-hidden="true">
              <SearchGlyph />
            </span>
            <input
              ref={inputRef}
              className="wss-input"
              type="search"
              name="wss-query"
              value={inputValue}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              onChange={handleChange}
            />
            {inputValue === '' ? null : (
              <button
                type="button"
                className="wss-iconButton wss-clear"
                onClick={handleClear}
                aria-label={t('search.clear')}
                title={t('search.clear')}
              >
                <ClearGlyph />
              </button>
            )}
            <button
              type="submit"
              className="wss-iconButton wss-submit"
              aria-label={t('search.submit')}
              title={t('search.submit')}
            >
              <SearchGlyph />
            </button>
          </div>
          <p className="wss-hint">{t('search.hint')}</p>
        </form>

        <div className="wss-statusLine" role="status" aria-live="polite">
          {status === 'loading' ? t('search.loading') : null}
          {status === 'ready' && result !== null && result.sessions.length > 0
            ? format(t('search.resultCount'), { sessions: result.sessions.length, hits: totalHits })
            : null}
          {status === 'ready' && result !== null && result.sessions.length === 0
            ? t('search.empty')
            : null}
          {status === 'error' ? t('search.error') : null}
        </div>

        {status === 'loading' ? <LoadingState /> : null}

        {status === 'error' && error !== null ? (
          <div className="wss-error" role="alert">
            <p className="wss-errorDetail">{describeError(t, error)}</p>
            <button type="button" className="wss-retry" onClick={retrySearch}>
              {t('search.retry')}
            </button>
          </div>
        ) : null}

        {hasResults && result !== null ? (
          <section className="wss-results" aria-label={t('search.results')}>
            <ol className="wss-groups">
              {result.sessions.map((group) => (
                <SessionGroupCard
                  key={group.sessionId}
                  group={group}
                  query={submittedQuery}
                  t={t}
                  onOpen={props.openSession}
                />
              ))}
            </ol>
            {appendError !== null ? (
              <div className="wss-error wss-errorInline" role="alert">
                <p className="wss-errorDetail">{describeError(t, appendError)}</p>
                <button type="button" className="wss-retry" onClick={retryAppend}>
                  {t('search.retry')}
                </button>
              </div>
            ) : null}
            {result.hasMore && typeof result.nextCursor === 'string' ? (
              <div className="wss-moreRow">
                <button type="button" className="wss-moreButton" onClick={loadMore} disabled={appending}>
                  {appending ? t('search.loadingMore') : t('search.more')}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {status === 'idle' ? (
          <RecentSection
            t={t}
            status={recentStatus}
            response={recent}
            error={recentError}
            onOpen={props.openSession}
            onRetry={loadRecent}
          />
        ) : null}
      </div>
    </div>
  )
}
