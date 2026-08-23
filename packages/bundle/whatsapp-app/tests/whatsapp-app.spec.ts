/**
 * The bundle is its patch file, and the license constraint that shapes it is
 * checked here rather than left to review: `baileys` reaches a GPL-3.0 package
 * which the 6.x line resolves from git, so this MIT repository declares it in
 * no manifest and the operator installs it into the profile instead. The rest
 * pins the composition decisions the README documents as operator contracts:
 * which rows compose, where credentials live, and how the out-of-tree library
 * is named.
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

const bundle = resolve(import.meta.dirname, '..')
const root = resolve(bundle, '../../..')
const patchFile = resolve(bundle, 'cordis.patch.yml')

const MANIFEST_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/** The rows the bundle inserts, in composition order. */
const EXPECTED_ROWS: { id: string; name: string }[] = [
  { id: 'whatsapp', name: '@deepseek-ai/dsh-whatsapp' },
  { id: 'whatsapp-baileys', name: '@deepseek-ai/dsh-whatsapp-baileys' },
  { id: 'whatsapp-workspace', name: '@deepseek-ai/dsh-whatsapp-workspace' },
  { id: 'tool-whatsapp', name: '@deepseek-ai/dsh-tool-whatsapp' },
  { id: 'ui-settings-whatsapp', name: '@deepseek-ai/dsh-client-ui-settings-whatsapp' },
]

function insertedRows(patches: PatchOptions[]): InsertedRow[] {
  expect(patches).toHaveLength(1)
  return patches[0]?.insert ?? []
}

describe('dsh-whatsapp-app bundle', () => {
  const source = readFileSync(patchFile, 'utf8')
  const rows = insertedRows(loadOverlayPatches('whatsapp-app-config-test', patchFile))

  it('declares the patch list through the dsh.bundle.patch manifest field', () => {
    const manifest = JSON.parse(readFileSync(resolve(bundle, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // Every row a bundle mounts resolves from the bundle's own dependencies.
    for (const row of EXPECTED_ROWS) expect(manifest.dependencies).toHaveProperty(row.name)
  })

  it('composes the seam, the provider, the router, the tool suite, and the pairing page', () => {
    expect(rows.map(row => ({ id: row.id, name: row.name }))).toEqual(EXPECTED_ROWS)
  })

  it('answers every conversation until a deployment narrows the scope', () => {
    const workspace = rows.find(row => row.id === 'whatsapp-workspace')
    expect(workspace?.config?.chats).toBe('all')
  })

  it('anchors both the credentials and the conversation directory to the same harness home', () => {
    // The provider's `authDir` default is cwd-relative and the router's
    // `directory` default ignores DSH_HOME entirely, so a second account would
    // otherwise split across two homes.
    expect(source).toContain("authDir: !!js dshHomePath('whatsapp', 'auth')")
    expect(source).toContain("directory: !!js dshHomePath('whatsapp', 'chats')")
  })

  it('prefers an explicit override, then the profile install, then the bare specifier', () => {
    expect(source).toContain(
      "moduleSpecifier: !!js process.env.DSH_WHATSAPP_BAILEYS ?? configModulePath('baileys') ?? 'baileys'",
    )
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
