/**
 * Card choosing which conversations the WhatsApp Workspace answers. Every
 * routed conversation gets its own session, so this decides how many sessions
 * the account can open, not how they are grouped.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { ConversationsController, WhatsAppChatScope } from './conversations.ts'
import type { WhatsAppLocaleKey } from './locales.ts'
import css from './WhatsAppSettingsSection.module.css'

/** The card's props: the bound translate and the routing face. */
export interface ConversationsCardProps {
  /** The section's bound translate. */
  t: (key: WhatsAppLocaleKey) => string
  /** Read, observe, and write the routing choice. */
  conversations: ConversationsController
}

/** The options offered, in the order they are shown. */
const OPTIONS: readonly { readonly id: WhatsAppChatScope; readonly labelKey: WhatsAppLocaleKey }[] = [
  { id: 'all', labelKey: 'chatsAll' },
  { id: 'groups', labelKey: 'chatsGroups' },
  { id: 'contacts', labelKey: 'chatsContacts' },
]

/**
 * Render the routing choice, or nothing at all when no Workspace serves it.
 * @param props - the bound translate and the routing face.
 * @returns the card element, or `null` where the deployment composed no Workspace.
 */
export function ConversationsCard({ t, conversations }: ConversationsCardProps): ReactNode {
  const state = useSyncExternalStore(conversations.subscribe, conversations.read, conversations.read)
  if (state.phase === 'absent') return null
  const disabled = state.phase !== 'ready' || !state.writable
  return (
    <div className={css.card} data-whatsapp-chats={state.chats}>
      <div className={css.heading}>
        <h3>{t('chatsTitle')}</h3>
      </div>
      <p className={css.body}>{t('chatsBody')}</p>
      <div className={css.choices} role="radiogroup" aria-label={t('chatsTitle')}>
        {OPTIONS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={state.chats === id}
            disabled={disabled}
            onClick={() => { conversations.select(id) }}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      {state.phase === 'ready' && !state.writable ? <p className={css.hint}>{t('chatsReadOnly')}</p> : null}
    </div>
  )
}
