/**
 * Assembled-app snapshot for the WhatsApp tool suite: the model lists the
 * account's conversations, reads one, is refused an address that names no
 * conversation and a send the operator rejects, sends the approved one, and
 * marks the chat read. The account and the operator are scripted, so the
 * transcript is the shipped code path without a paired phone.
 * @module whatsapp-snapshot
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), 'whatsapp-snapshots/tool-suite')
const replayFixture = join(scenarioDir, 'replay.jsonl')
const replayOverride = join(scenarioDir, 'replay.override.json')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../whatsapp.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Answer Ana about the time, then mark her conversation read.'

interface JsonObject {
  [key: string]: unknown
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as JsonObject)
}

/** Read the one session the run persisted, failing loud when the count is not one. */
async function persistedLog(cwd: string): Promise<string> {
  const root = join(cwd, '.sessions')
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
  const file = files[0]
  if (files.length !== 1 || file === undefined) {
    throw new Error(`expected exactly one persisted session, found ${files.length}`)
  }
  return readFile(join(root, file), 'utf8')
}

describe('whatsapp tool-suite snapshot', () => {
  it('reads the account, refuses two sends, and logs the approved one', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'whatsapp tool suite headless stream-json snapshot',
      tempDirPrefix: 'dsh-whatsapp-tool-suite-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: (runCwd: string) => {
        cwd = runCwd
      },
      inspect: async () => {
        const content = await persistedLog(cwd)
        const header = parseJsonl(content)[0]
        const normalization: NormalizeContext = {
          sessionIds: typeof header?.id === 'string' ? [header.id] : [],
          cwd,
        }
        const session = scrubRequestHeaders(normalizeSessionLog(content, normalization))
        if (refreshing) await writeFile(sessionExpected, session)
        expect(session).toBe(await readFile(sessionExpected, 'utf8'))

        const records = parseJsonl(session)
        // Model-visible ⟺ logged: exactly the approved send is in the log.
        const outbound = records.filter(record => record.type === 'whatsapp/outbound')
        expect(outbound).toHaveLength(1)
        expect(outbound[0]?.data).toMatchObject({
          chatId: '5511999990000@s.whatsapp.net',
          chatName: 'Ana',
          text: 'boa tarde, chego as 18h',
        })
        // The operator was asked once per send that reached approval; the
        // account refused an address that names no conversation before that.
        expect(records.filter(record => record.type === 'approval/asked')).toHaveLength(2)
        expect(session).toContain('\\"Ana\\" names no conversation')
      },
    })

    expect(result.stderr).toBe('')
    expect(parseJsonl(result.stdout).at(-1)).toMatchObject({ type: 'result', output: 'WHATSAPP_TOOLS_DONE' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
