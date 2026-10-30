/** Minimal structural types for the client half. The host page owns the real contracts. */

import type { RemoteResult } from '../shared/contract'

export interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => Record<string, unknown>
  store?: unknown
  children?: Record<string, unknown>
  [key: string]: unknown
}

export interface SlotsApi {
  inject(name: string, callback: () => (() => void) | void): (() => void) | void
  register(options: SlotRegistration, component: unknown): () => void
}

export interface LocaleApi {
  register(namespace: string, language: string, dict: Record<string, string>): () => void
  getSnapshot?(): { language?: string; [key: string]: unknown }
  resolveText?(text: unknown): string
}

export interface ConnectionApi {
  rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RemoteResult<unknown>>
  }
}

export interface UiWorkspaceApi {
  openSession(target: string): void
}

export interface LayoutApi {
  selectPanel(id: string | null): void
  panelInfo?: { getSnapshot(): { activePanelId?: string | null } }
}

export interface ClientContext {
  slots: SlotsApi
  locale: LocaleApi
  effect(fn: () => (() => void) | void, label?: string): void
  inject(deps: string[], callback: (scoped: ClientContext) => void): { dispose?(): void }
  get(name: string): unknown
  [key: string]: unknown
}

/** Values injected into the panel component through the slot registration. */
export interface PanelFace {
  t: (key: string) => string
  search: (request: import('../shared/contract').SearchRequest, signal?: AbortSignal) => Promise<import('../shared/contract').SearchResponse>
  recent: (request: import('../shared/contract').RecentRequest, signal?: AbortSignal) => Promise<import('../shared/contract').RecentResponse>
  openSession: (sessionId: string) => void
  panelId: string
}
