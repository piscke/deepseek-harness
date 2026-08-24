/**
 * Assembled-app snapshot for the WhatsApp Workspace: one conversation's
 * messages open one session, titled with the name the account resolves, and
 * wait there as pending context until the operator's prompt carries them into a
 * request. The account writing from its paired phone is one of them; the
 * deployment's own answer coming back is not. The account is scripted, so the
 * transcript is the shipped routing path without a phone.
 * @module whatsapp-routing-snapshot
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), 'whatsapp-snapshots/one-conversation')
const replayFixture = join(scenarioDir, 'replay.jsonl')
const replayOverride = join(scenarioDir, 'replay.override.json')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../whatsapp-routing.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/whatsapp-inbound-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const inbound = 'boa tarde, confirmo as 18h'
const prompt = 'o que a Ana disse?'
/** The answer the driver dispatches through the seam, which the account observes again. */
const agentAnswer = 'confirmado, obrigado'
/** What the driver publishes as the operator writing from the paired phone. */
const operatorText = 'era isso mesmo?'

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

describe('whatsapp per-conversation snapshot', () => {
  it('holds an inbound message as pending context until the operator prompts', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'whatsapp per-conversation headless stream-json snapshot',
      tempDirPrefix: 'dsh-whatsapp-one-conversation-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, prompt, inbound],
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
        // Model-visible ⟺ logged: the contact's message and the one the
        // operator wrote from the paired phone both reached the model as inbox
        // entries of this conversation's own session.
        expect(session).toContain(inbound)
        expect(session).toContain(operatorText)
        // The deployment's own answer came back as the account's own traffic
        // and was claimed as an echo, so the agent is never woken by its words.
        expect(session).not.toContain(agentAnswer)
        expect(records.filter(record => record.type === 'whatsapp/inbound')).toHaveLength(2)
        // Delivery is passive: exactly one turn ran, opened by the operator's
        // prompt, and both messages rode into it as already-pending context.
        const claimed = records.filter(record => record.type === 'agent/inbox/spliced')
        expect(claimed.length).toBeGreaterThan(0)
        expect(records.filter(record => record.type === 'turn/start')).toHaveLength(1)
        expect(session).toContain(prompt)
        // The conversation is titled by the name the account resolved, not by
        // its address and not by an automatic summary.
        const titles = records.filter(record => record.type === 'session/title')
        expect(titles.at(-1)?.data).toMatchObject({ title: 'Ana', source: { kind: 'user' } })
      },
    })

    expect(result.stderr).toBe('')
    expect(parseJsonl(result.stdout).at(-1)).toMatchObject({ type: 'result', output: 'WHATSAPP_ROUTED', title: 'Ana' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
