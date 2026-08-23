/**
 * The routing choice the WhatsApp page edits, read from and written to the
 * Workspace's settings namespace.
 *
 * The card shows one field of that namespace: which conversations open a
 * session. The rest of the namespace — the allow and deny lists, the agent
 * preset — has no control here yet, and a field this card never writes is left
 * exactly as the deployment or another surface left it.
 */

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { WHATSAPP_CHATS_FIELD } from '../workspace-settings.ts'
import type { WhatsAppChatScope, WhatsAppWorkspaceSection } from '../workspace-settings.ts'

export { WHATSAPP_WORKSPACE_NS } from '../workspace-settings.ts'
export type { WhatsAppChatScope, WhatsAppWorkspaceSection } from '../workspace-settings.ts'

/** What the conversations card renders. */
export interface ConversationsState {
  /**
   * `absent` while no Workspace serves the namespace, so the card is not shown
   * at all; `loading` until the first section is accepted; `ready` once the
   * choice below is the one in force.
   */
  phase: 'absent' | 'loading' | 'ready'
  /** The routed conversations, as last accepted from the Host. */
  chats: WhatsAppChatScope
  /** Whether this browser may write the choice; a read-only page still shows it. */
  writable: boolean
}

/**
 * The routing choice a deployment that stored none is running under. It repeats
 * the Workspace's own default so the card can render before the first section
 * arrives; the Host stays the authority, and an accepted section replaces it.
 */
const DEFAULT_SCOPE: WhatsAppChatScope = 'all'

/**
 * Reactive read/write face over the Workspace's routing choice. `read` derives
 * from the bound scope on every call and caches the result, so the card can
 * subscribe to it as an external store: a snapshot must keep the same reference
 * until something the card renders actually changed.
 */
export class ConversationsController {
  private state: ConversationsState

  /** @param scope - the bound settings scope for the Workspace's namespace. */
  constructor(private readonly scope: SettingsScope<WhatsAppWorkspaceSection>) {
    this.state = derive(scope.getSnapshot())
  }

  /**
   * Snapshot the routing choice for this render.
   * @returns the current card state, stable until the Host changes it.
   */
  read = (): ConversationsState => {
    const next = derive(this.scope.getSnapshot())
    if (!same(this.state, next)) this.state = next
    return this.state
  }

  /**
   * Observe changes to the routing choice.
   * @param listener - invoked after the state this card renders changed.
   * @returns the disposer removing this listener.
   */
  subscribe = (listener: () => void): (() => void) => this.scope.subscribe(() => {
    if (same(this.state, derive(this.scope.getSnapshot()))) return
    listener()
  })

  /**
   * Write the routing choice the user picked. The card keeps rendering the
   * accepted value, so a refused write shows up as the choice staying put.
   * @param chats - the conversations the Workspace should answer.
   */
  select = (chats: WhatsAppChatScope): void => {
    if (chats === this.read().chats) return
    void this.scope.set(WHATSAPP_CHATS_FIELD, chats)
  }
}

/**
 * Project one scope snapshot onto what the card renders.
 * @param snapshot - the current settings-scope snapshot.
 * @returns the card state for it.
 */
function derive(snapshot: SettingsScopeSnapshot<WhatsAppWorkspaceSection>): ConversationsState {
  return {
    phase: snapshot.status === 'unavailable' ? 'absent' : snapshot.status === 'ready' ? 'ready' : 'loading',
    chats: snapshot.value?.chats ?? DEFAULT_SCOPE,
    writable: snapshot.writable,
  }
}

function same(left: ConversationsState, right: ConversationsState): boolean {
  return left.phase === right.phase && left.chats === right.chats && left.writable === right.writable
}
