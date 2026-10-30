/**
 * The client plugin: styles, dictionaries, the `main` keyed panel and its
 * sidebar entry, plus the Remote-bound face the panel renders with.
 */

import React from 'react'
import { createSearchApi } from './api'
import { currentLanguage, lookup, NS, pageDicts } from './i18n'
import { SearchPanel } from './panel'
import type { ClientContext, LayoutApi, PanelFace, UiWorkspaceApi } from './types'
import { PANEL_ID } from '../shared/contract'
import styles from './styles.css?inline'

export interface ClientPlugin {
  inject: string[]
  apply(ctx: ClientContext): void
}

/** Sidebar glyph for the panel list; the shell passes the target pixel size. */
function SearchPanelIcon(props: { size?: number; active?: boolean; [key: string]: unknown }): React.ReactElement {
  const size = typeof props.size === 'number' ? props.size : 18
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('circle', { cx: 11, cy: 11, r: 6.5 }),
    React.createElement('path', { d: 'm16 16 4.5 4.5' }),
  )
}

export default function createPlugin(): ClientPlugin {
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      const language = (): string => currentLanguage(ctx)
      const t = (key: string): string => lookup(language(), key, pageDicts)

      // Compiled stylesheet, injected once for this plugin's lifetime.
      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const element = document.createElement('style')
        element.dataset.dshPlugin = 'dsh-workspace-session-search'
        element.textContent = styles
        document.head.appendChild(element)
        return () => {
          element.remove()
        }
      }, 'dsh-workspace-session-search: styles')

      ctx.effect(() => {
        const disposers = [ctx.locale.register(NS, 'en', pageDicts.en), ctx.locale.register(NS, 'zh', pageDicts.zh)]
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          }
        }
      }, 'dsh-workspace-session-search: dictionaries')

      const api = createSearchApi(ctx)

      const openSession = (sessionId: string): void => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspaceApi | undefined
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
            uiWorkspace.openSession(sessionId)
            return
          }
        } catch {
          /* fall through to selecting the conversation panel */
        }
        try {
          const layout = ctx.get('layout') as LayoutApi | undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        } catch {
          /* ignore */
        }
      }

      const face: PanelFace = {
        t,
        openSession,
        panelId: PANEL_ID,
        search: (request, signal) => api.search(request, signal),
        recent: (request, signal) => api.recent(request, signal),
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ ...face }),
          },
          SearchPanel,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            locale: NS,
            label: () => t('panel.label'),
          },
          SearchPanelIcon,
        ),
      )
    },
  }
}
