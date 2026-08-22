// @vitest-environment jsdom
// The pairing surface as an operator meets it: `dsh web --patch
// examples/whatsapp-assistant/cordis.yml`, Settings, WhatsApp. Only the
// assembled graph proves the opt-in row reaches the boot manifest at all, that
// the section nav projects it, and that the QR reaches the panel from the
// loopback channel — the package bench mounts the component directly and can
// prove none of that.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN, WHATSAPP_ASSISTANT_LAYER } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/whatsapp-settings/pairing-section.expected.txt')

installAssembledBootEnv()

/**
 * Open Settings and select the WhatsApp page.
 * @returns the settings dialog element.
 */
async function openWhatsAppSection(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: 'Settings' }, { timeout: 10_000 })
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'Settings' }, { timeout: 10_000 })
  fireEvent.click(within(dialog).getByRole('button', { name: 'WhatsApp' }))
  return dialog
}

describe('assembled WhatsApp pairing section', () => {
  it('renders the rotating pairing code inside Settings', async () => {
    mountAssembledApp('?fixture&fixtureWhatsApp=pairing', [WHATSAPP_ASSISTANT_LAYER])

    const dialog = await openWhatsAppSection()
    const card = await waitFor(() => {
      const found = dialog.querySelector<HTMLElement>('[data-whatsapp-state="pairing"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })

    // The QR is the point: an <svg> encoding the fixture's payload, labelled for
    // a screen reader, beside the credential warning.
    const qr = within(card).getByRole('img', { name: 'WhatsApp pairing QR code' })
    expect(qr.tagName.toLowerCase()).toBe('svg')
    expect(card.querySelector('[data-whatsapp-qr]')).not.toBeNull()
    expect(qr.querySelectorAll('path').length).toBeGreaterThan(0)

    const shape = [
      `state=${card.dataset.whatsappState}`,
      `qr=svg(${qr.querySelectorAll('path').length} path)`,
      `title=${within(card).getByRole('heading').textContent}`,
      `warning=${card.textContent?.includes('whoever scans it links a device') ?? false}`,
    ].join('\n') + '\n'
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })

  it('renders the connected account once pairing is done', async () => {
    mountAssembledApp('?fixture&fixtureWhatsApp=online', [WHATSAPP_ASSISTANT_LAYER])

    const dialog = await openWhatsAppSection()
    const card = await waitFor(() => {
      const found = dialog.querySelector<HTMLElement>('[data-whatsapp-state="online"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    expect(card.querySelector('[data-whatsapp-account]')?.textContent).toBe('55119xxxxxxxx@s.whatsapp.net')
    expect(card.querySelector('[data-whatsapp-qr]')).toBeNull()
  })

  it('offers no WhatsApp page without the overlay', async () => {
    mountAssembledApp('?fixture&fixtureWhatsApp=pairing')

    const trigger = await screen.findByRole('button', { name: 'Settings' }, { timeout: 10_000 })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' }, { timeout: 10_000 })
    expect(within(dialog).queryByRole('button', { name: 'WhatsApp' })).toBeNull()
  })
})
