import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { ConversationsCard } from './ConversationsCard.tsx'
import type { ConversationsController } from './conversations.ts'
import css from './WhatsAppSettingsSection.module.css'

/** Registration-side face used by the section. */
export interface WhatsAppSettingsSectionInjected {
  /**
   * Read the account's current connection state over the loopback pairing
   * channel. Rejects when the channel is unreachable or answered with an error.
   */
  readStatus: (signal: AbortSignal) => Promise<WhatsAppStatus>
  /** Delay between two reads while the section stays mounted. */
  pollIntervalMs: number
  /** Read, observe, and write which conversations the Workspace answers. */
  conversations: ConversationsController
}

/** Full component props assembled by the Settings slot renderer. */
export type WhatsAppSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.whatsapp'>
  & InjectFace<WhatsAppSettingsSectionInjected>

type ViewState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly status: WhatsAppStatus }

/** Side of the rendered pairing QR, in CSS pixels. */
const QR_SIZE = 220

function assertNever(value: never): never {
  throw new Error(`unhandled WhatsApp status: ${JSON.stringify(value)}`)
}

/**
 * Render the card body for one connection state.
 * @param status - the decoded status arm.
 * @param t - the section's bound translate.
 * @returns the heading, explanation, and any state-specific content.
 */
export function StatusCard({ status, t }: {
  status: WhatsAppStatus
  t: WhatsAppSettingsSectionProps['t']
}): ReactNode {
  switch (status.state) {
    case 'offline':
      return (
        <StatusShell state={status.state} title={t('offlineTitle')}>
          <p className={css.body}>{t('offlineBody')}</p>
        </StatusShell>
      )
    case 'connecting':
      return (
        <StatusShell state={status.state} title={t('connectingTitle')}>
          <p className={css.body}>{t('connectingBody')}</p>
        </StatusShell>
      )
    case 'pairing':
      return (
        <StatusShell state={status.state} title={t('pairingTitle')}>
          <p className={css.body}>{t('pairingBody')}</p>
          <div className={css.qr} data-whatsapp-qr>
            <QRCodeSVG value={status.qr} size={QR_SIZE} role="img" aria-label={t('qrLabel')} />
          </div>
          <p className={css.hint}>{t('pairingRotates')}</p>
          <p className={css.warning}>{t('pairingWarning')}</p>
        </StatusShell>
      )
    case 'online':
      return (
        <StatusShell state={status.state} title={t('onlineTitle')}>
          {status.accountId === undefined ? <p className={css.body}>{t('onlineUnknownAccount')}</p> : (
            <dl className={css.details}>
              <div>
                <dt>{t('onlineAccount')}</dt>
                <dd data-whatsapp-account>{status.accountId}</dd>
              </div>
            </dl>
          )}
        </StatusShell>
      )
    case 'logged-out':
      return (
        <StatusShell state={status.state} title={t('loggedOutTitle')}>
          <p className={css.body}>{t('loggedOutBody')}</p>
          <dl className={css.details}>
            <div>
              <dt>{t('loggedOutReason')}</dt>
              <dd data-whatsapp-reason>{status.reason}</dd>
            </div>
          </dl>
        </StatusShell>
      )
    default:
      return assertNever(status)
  }
}

/**
 * Card chrome shared by every state: the state dot, its title, and the body.
 * @param props - the state tag used as a styling hook, the title, and content.
 * @returns the card element.
 */
function StatusShell({ state, title, children }: {
  state: WhatsAppStatus['state']
  title: string
  children: ReactNode
}): ReactNode {
  return (
    <div className={css.card} data-whatsapp-state={state}>
      <div className={css.heading}>
        <span className={css.dot} data-state={state} aria-hidden="true" />
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  )
}

/**
 * Render the WhatsApp connection state and, while the account is pairing, the
 * live QR, followed by the routing choice the Workspace applies to the messages
 * that account receives. The status is re-read on a fixed cadence for as long
 * as the section is mounted: the provider replaces the payload whenever it
 * rotates, and a stale code cannot be scanned.
 * @param props - slot runtime props, the bound translate, and the injected face.
 * @returns the section content.
 */
export function WhatsAppSettingsSection({
  readStatus,
  pollIntervalMs,
  conversations,
  t,
}: WhatsAppSettingsSectionProps): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ViewState>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const run = (): void => {
      const settle = (next: ViewState): void => {
        if (!active) return
        setState(next)
        timer = setTimeout(run, pollIntervalMs)
      }
      void readStatus(controller.signal).then(
        (status) => { settle({ phase: 'ready', status }) },
        () => { settle({ phase: 'error' }) },
      )
    }
    run()
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [attempt, pollIntervalMs, readStatus])

  const retry = useCallback((): void => {
    setState({ phase: 'loading' })
    setAttempt(value => value + 1)
  }, [])

  return (
    <div className={css.section} aria-busy={state.phase === 'loading'}>
      {state.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.phase === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.phase === 'ready' ? <StatusCard status={state.status} t={t} /> : null}
      <ConversationsCard t={t} conversations={conversations} />
    </div>
  )
}
