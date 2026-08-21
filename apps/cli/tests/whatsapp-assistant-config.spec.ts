/**
 * The WhatsApp assistant example stays config-only, and the license constraint
 * that shapes it is checked here rather than left to review: `baileys` reaches
 * a GPL-3.0 dependency resolved from git, which this MIT repository's pnpm
 * policy rejects (`ERR_PNPM_EXOTIC_SUBDEP`), so it must appear in no manifest.
 * The rest pins the overlay decisions the README documents as operator
 * contracts: which rows compose, where credentials live, and how the
 * out-of-tree library is named.
 */

import { globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

interface InsertedRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

const root = resolve(import.meta.dirname, '../../..')
const overlay = resolve(root, 'examples/whatsapp-assistant/cordis.yml')

const MANIFEST_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/** The rows the overlay inserts, in composition order. */
const EXPECTED_ROWS: { id: string; name: string }[] = [
  { id: 'whatsapp', name: '@deepseek-ai/dsh-whatsapp' },
  { id: 'whatsapp-baileys', name: '@deepseek-ai/dsh-whatsapp-baileys' },
  { id: 'whatsapp-workspace', name: '@deepseek-ai/dsh-whatsapp-workspace' },
  { id: 'tool-whatsapp', name: '@deepseek-ai/dsh-tool-whatsapp' },
]

function insertedRows(patches: PatchOptions[]): InsertedRow[] {
  expect(patches).toHaveLength(1)
  return patches[0]?.insert ?? []
}

describe('whatsapp-assistant example overlay', () => {
  const source = readFileSync(overlay, 'utf8')
  const rows = insertedRows(loadOverlayPatches('whatsapp-assistant-config-test', overlay))

  it('composes the seam, the provider, the router, and the tool suite', () => {
    expect(rows.map(row => ({ id: row.id, name: row.name }))).toEqual(EXPECTED_ROWS)
  })

  it('routes conversations by category, which is what makes the two standing sessions appear', () => {
    const workspace = rows.find(row => row.id === 'whatsapp-workspace')
    expect(workspace?.config?.route).toBe('category')
  })

  it('anchors both the credentials and the conversation directory to the same harness home', () => {
    // The provider's `authDir` default is cwd-relative and the router's
    // `directory` default ignores DSH_HOME entirely, so a second account would
    // otherwise split across two homes.
    expect(source).toContain("authDir: !!js dshHomePath('whatsapp', 'auth')")
    expect(source).toContain("directory: !!js dshHomePath('whatsapp', 'chats')")
  })

  it('names the operator-installed library through the environment, defaulting to the bare specifier', () => {
    expect(source).toContain("moduleSpecifier: !!js process.env.DSH_WHATSAPP_BAILEYS ?? 'baileys'")
  })

  it('carries no credential material', () => {
    expect(source).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}\b/)
    expect(source).not.toContain('DEEPSEEK_API_KEY')
  })

  it('leaves baileys out of every manifest in the repository', () => {
    const manifests = globSync('**/package.json', {
      cwd: root,
      exclude: (file: string) => file.includes('node_modules') || file.includes('/lib/') || file.includes('\\lib\\'),
    })
    const offenders = manifests.filter((file) => {
      const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as Record<string, unknown>
      return MANIFEST_DEPENDENCY_FIELDS.some((field) => {
        const declared = manifest[field]
        return typeof declared === 'object' && declared !== null && 'baileys' in declared
      })
    })
    expect(offenders.map(file => relative(root, file))).toEqual([])
  })
})
