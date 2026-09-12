/**
 * LIVE end-to-end test against the real DeepSeek API.
 *
 * This is the only test in the repo that does NOT mock `fetch`. It is skipped
 * cleanly when `DEEPSEEK_API_KEY` is absent, so it can never fail the offline
 * suite (`npm test` / `npm run verify`).
 *
 * To run it: set DEEPSEEK_API_KEY and execute `npx vitest run tests/live.test.ts`
 * (or simply `npm run live` for the standalone script with richer reporting).
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../lib/config.js'
import { loadDotenv } from '../lib/dotenv.js'
import { createMessages, runAgent } from '../lib/harness.js'
import { DEFAULT_TIMEOUT_MS, createDeepSeekClient } from '../lib/llm.js'
import { createCoreTools } from '../lib/tools.js'
import type { AgentEvent } from '../lib/types.js'

/** Repository root — `tests/` sits directly underneath it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Forces two `read_file` calls followed by the terminal `finish` tool. */
const LIVE_TASK =
  'Read package.json and lib/types.ts, then call the finish tool with a one-line summary of what this project is and how many tools it exposes.'

const SYSTEM_PROMPT =
  'You are a coding agent working inside a repository. Use the provided tools to inspect the files you are asked about and never invent file contents. When you have the information, call the finish tool with a concise summary.'

// Opt-in `.env` loading so a gitignored ZooCode/.env works without a restart.
loadDotenv()

/** Presence check only — the key itself is never read, printed, or asserted on. */
const apiKeyPresent =
  typeof process.env.DEEPSEEK_API_KEY === 'string' &&
  process.env.DEEPSEEK_API_KEY.trim().length > 0

/**
 * Live tests are DOUBLE opt-in: a key must exist AND `ZOO_LIVE=1` must be set.
 * Without the flag this suite skips, so `npm run verify` stays offline and
 * deterministic — merely having a key in `.env` must never make the gate hit
 * the network (and spend tokens) as a side effect.
 *
 *   PowerShell:  $env:ZOO_LIVE=1; npx vitest run tests/live.test.ts
 *   bash/zsh:    ZOO_LIVE=1 npx vitest run tests/live.test.ts
 *
 * `npm run live` is the richer, primary way to exercise the live path.
 */
const liveEnabled = apiKeyPresent && process.env.ZOO_LIVE === '1'

describe.skipIf(!liveEnabled)(
  'live DeepSeek end-to-end (requires DEEPSEEK_API_KEY + ZOO_LIVE=1)',
  () => {
  it(
    'completes a multi-step tool-using task with ok:true and at least one tool call',
    async () => {
      const loaded = loadConfig()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok || !loaded.data) return

      const config = loaded.data
      const toolCalls: string[] = []
      const onEvent = (event: AgentEvent): void => {
        if (event.type === 'tool_call') toolCalls.push(event.tool)
      }

      const result = await runAgent({
        llm: createDeepSeekClient({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        tools: createCoreTools(),
        messages: createMessages(LIVE_TASK, SYSTEM_PROMPT),
        maxSteps: config.maxSteps,
        model: config.model,
        cwd: REPO_ROOT,
        onEvent,
      })

      expect(result.ok).toBe(true)
      expect(toolCalls.length).toBeGreaterThanOrEqual(1)
      expect(result.final.trim().length).toBeGreaterThan(0)
    },
    120_000,
  )
})
