#!/usr/bin/env tsx
/**
 * Live end-to-end verification of the ZooCode harness against the REAL
 * DeepSeek API.
 *
 * Every other test in this repo mocks `fetch`; this script exercises the real
 * transport hop by hop:
 *
 *   loadConfig()            (lib/config.ts  — env resolution)
 *   createDeepSeekClient()  (lib/llm.ts     — the real HTTP client)
 *   createCoreTools()       (lib/tools.ts   — the built-in tool registry)
 *   runAgent()              (lib/harness.ts — the agentic loop)
 *
 * The default task forces REAL multi-step tool use against this repository:
 * two `read_file` calls followed by the terminal `finish` tool.
 *
 * Usage:
 *   npx tsx scripts/live-test.ts [--model <name>] [--task "<prompt>"]
 *                                [--max-steps <n>] [--json]
 *
 * Exit codes:
 *   0  run was `ok`, at least one tool executed, and final text is non-empty
 *   1  the run failed, no tool executed, or final text was empty
 *   2  no API key resolvable (DEEPSEEK_API_KEY absent) — NO request attempted
 *
 * SECURITY: the API key is never printed, logged, or serialized. The only
 * thing ever surfaced about it is a boolean `apiKeyPresent`.
 *
 * ACCOUNTING: a completed run also appends ONE aggregate entry to the local
 * usage ledger (`.zoo/usage.jsonl`) via `recordUsage` — same `kind: 'agent'`
 * shape and the same two documented skips (`ZOO_NO_USAGE=1`, zero total tokens)
 * as the CLI's `withUsageRecording` / `persistUsage` pair in
 * [`bin/zoocode.ts`](../bin/zoocode.ts). Ledger failures are reported on stderr
 * and never change the exit code.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENV_KEYS, loadConfig } from '../lib/config.js'
import { loadDotenv } from '../lib/dotenv.js'
import { createMessages, runAgent } from '../lib/harness.js'
import { DEFAULT_TIMEOUT_MS, createDeepSeekClient } from '../lib/llm.js'
import { createCoreTools } from '../lib/tools.js'
import { makeRunId, recordUsage, type UsageEntry } from '../lib/usage.js'
import type { AgentEvent, LlmClient, LlmRequest, LlmResponse } from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Repository root — `scripts/` sits directly underneath it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Default task: exercises `read_file` twice, then the terminal `finish` tool. */
const DEFAULT_TASK =
  'Read package.json and lib/types.ts, then call the finish tool with a one-line summary of what this project is and how many tools it exposes.'

/** Minimal steer toward real tool use without inventing file contents. */
const SYSTEM_PROMPT =
  'You are a coding agent working inside a repository. Use the provided tools to inspect the files you are asked about and never invent file contents. When you have the information, call the finish tool with a concise summary.'

/** Exact PowerShell command shown when the key is absent (user scope, persistent). */
const SET_KEY_COMMAND =
  '[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")   # then restart VS Code'
const RUN_COMMAND = 'npx tsx scripts/live-test.ts'

/** Max length of the `label` written to the ledger (mirrors the CLI's cap). */
const LABEL_MAX = 80

/* -------------------------------------------------------------------------- */
/* Arg parsing (hand-rolled, no dependencies)                                 */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  model?: string
  task: string
  maxSteps?: number
  json: boolean
  help: boolean
  error?: string
}

/** Split `--flag=value` into two tokens so the parser only handles one shape. */
function normalize(argv: string[]): string[] {
  const out: string[] = []
  for (const token of argv) {
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=')
      out.push(token.slice(0, eq), token.slice(eq + 1))
    } else {
      out.push(token)
    }
  }
  return out
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { task: DEFAULT_TASK, json: false, help: false }

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]

    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--model' || token === '--task' || token === '--max-steps') {
      const value = argv[index + 1]
      if (value === undefined) {
        options.error = `Missing value for ${token}`
        return options
      }
      index += 1
      if (token === '--model') {
        options.model = value
      } else if (token === '--task') {
        options.task = value
      } else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) {
          options.error = `--max-steps must be a positive integer (received "${value}")`
          return options
        }
        options.maxSteps = parsed
      }
      continue
    }

    options.error = `Unknown argument: ${token}`
    return options
  }

  return options
}

function printHelp(): void {
  console.log(`
  ZooCode live harness test — verifies the REAL DeepSeek path end to end.

  Usage: npx tsx scripts/live-test.ts [options]

  Options:
    --model <name>    Model to use (default: DEEPSEEK_MODEL or "deepseek-chat")
    --task "<prompt>" Task to run (default: read package.json + lib/types.ts,
                      then call finish with a summary)
    --max-steps <n>   Maximum agent steps (default: ZOO_MAX_STEPS or 25)
    --json            Print a single JSON object (diagnostics go to stderr)
    -h, --help        Show this help

  Exit codes: 0 ok | 1 failed run | 2 no API key (no request attempted)
`)
}

/* -------------------------------------------------------------------------- */
/* Instrumentation                                                            */
/* -------------------------------------------------------------------------- */

interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
}

interface RecordingLlm {
  client: LlmClient
  usage: UsageTotals
}

/**
 * Wrap the real client so token usage can be accumulated per `chat()` call
 * (the harness event stream intentionally carries no usage).
 */
function createRecordingClient(inner: LlmClient): RecordingLlm {
  const usage: UsageTotals = { requests: 0, promptTokens: 0, completionTokens: 0 }

  const client: LlmClient = {
    async chat(req: LlmRequest): Promise<LlmResponse> {
      usage.requests += 1
      const response = await inner.chat(req)
      usage.promptTokens += response.usage?.promptTokens ?? 0
      usage.completionTokens += response.usage?.completionTokens ?? 0
      return response
    },
  }

  return { client, usage }
}

/* -------------------------------------------------------------------------- */
/* Usage ledger                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Append the run's token usage to `<REPO_ROOT>/.zoo/usage.jsonl`.
 *
 * The totals come from the recording wrapper above (the harness event stream
 * deliberately carries no usage), `steps` from the run result, and the rest from
 * the run itself. Two skips keep the local ledger meaningful, exactly as
 * `persistUsage` in [`bin/zoocode.ts`](../bin/zoocode.ts) documents them:
 *  - `ZOO_NO_USAGE=1` — an explicit opt-out for scripts and CI.
 *  - **zero total tokens** — nothing to account for, so nothing is written.
 *
 * A run is `ok` for accounting purposes only when it both succeeded AND verified
 * live tool use, i.e. the same value the exit code is derived from. Never
 * throws: an unwritable ledger is reported on stderr and ignored.
 */
function recordRunUsage(input: {
  model: string
  steps: number
  durationMs: number
  ok: boolean
  label: string
  recorder: RecordingLlm
}): void {
  try {
    if (process.env.ZOO_NO_USAGE === '1') return

    const { promptTokens, completionTokens } = input.recorder.usage
    const totalTokens = promptTokens + completionTokens
    if (totalTokens === 0) return

    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      kind: 'agent',
      model: input.model,
      runId: makeRunId(),
      steps: input.steps,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs: input.durationMs,
      ok: input.ok,
    }
    const label = truncate(input.label, LABEL_MAX)
    if (label.length > 0) entry.label = label

    const recorded = recordUsage(entry)
    if (!recorded.ok) {
      console.error(`[usage] not recorded: ${recorded.error ?? 'unknown error'}`)
    }
  } catch (err) {
    // Telemetry must never be able to fail the live test (or change its exit code).
    console.error(`[usage] not recorded: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface ToolCallRecord {
  step: number
  tool: string
  args: Record<string, unknown>
}

interface ToolResultRecord {
  step: number
  tool: string
  ok: boolean
  content: string
}

interface Collected {
  toolCalls: ToolCallRecord[]
  toolResults: ToolResultRecord[]
  llmRequests: number
  llmResponses: number
  done: boolean
  errors: string[]
}

/** Turn the typed `onEvent` stream into flat, reportable observations. */
function createCollector(): { events: Collected; onEvent: (event: AgentEvent) => void } {
  const events: Collected = {
    toolCalls: [],
    toolResults: [],
    llmRequests: 0,
    llmResponses: 0,
    done: false,
    errors: [],
  }

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'llm_request':
        events.llmRequests += 1
        break
      case 'llm_response':
        events.llmResponses += 1
        break
      case 'tool_call':
        events.toolCalls.push({ step: event.step, tool: event.tool, args: event.args })
        break
      case 'tool_result':
        events.toolResults.push({
          step: event.step,
          tool: event.tool,
          ok: event.ok,
          content: event.content,
        })
        break
      case 'done':
        events.done = true
        break
      case 'error':
        events.errors.push(event.error)
        break
    }
  }

  return { events, onEvent }
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max)}…`
}

interface LiveReport {
  ok: boolean
  apiKeyPresent: boolean
  model: string
  task: string
  cwd: string
  steps: number
  durationMs: number
  llmRequests: number
  llmResponses: number
  toolCallCount: number
  toolsUsed: string[]
  uniqueTools: string[]
  usedAtLeastOneTool: boolean
  final: string
  finalNonEmpty: boolean
  usage: { promptTokens: number; completionTokens: number }
  toolResults: { step: number; tool: string; ok: boolean; content: string }[]
  eventErrors: string[]
  error: string | null
  pass: boolean
}

function renderHuman(report: LiveReport): string {
  const lines: string[] = []
  lines.push('ZooCode live harness test (REAL DeepSeek API)')
  lines.push(`  model:      ${report.model}`)
  lines.push(`  cwd:        ${report.cwd}`)
  lines.push(`  task:       ${report.task}`)
  lines.push('')
  lines.push('Observed')
  lines.push(`  (a) tool call occurred:     ${report.usedAtLeastOneTool ? 'YES' : 'NO'}`)
  lines.push(
    `  (b) tools used:             ${report.toolsUsed.length > 0 ? report.toolsUsed.join(', ') : '(none)'}`,
  )
  lines.push(`      llm requests/responses: ${report.llmRequests}/${report.llmResponses}`)
  for (const record of report.toolResults) {
    const state = record.ok ? 'ok' : 'FAILED'
    lines.push(`      step ${record.step} ${record.tool} -> ${state}: ${truncate(record.content, 200)}`)
  }
  lines.push(`  (c) final text:             ${report.final.length > 0 ? report.final : '(empty)'}`)
  lines.push(`  (d) steps:                  ${report.steps}`)
  lines.push(
    `  (e) usage:                  prompt=${report.usage.promptTokens} completion=${report.usage.completionTokens}`,
  )
  lines.push(`  (f) duration:               ${report.durationMs} ms`)
  if (report.error) lines.push(`  error:                      ${report.error}`)
  if (report.eventErrors.length > 0) {
    lines.push(`  event errors:               ${report.eventErrors.join(' | ')}`)
  }
  lines.push('')
  lines.push(report.pass ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
  return lines.join('\n')
}

/** No key: report clearly and never attempt a request. */
function reportMissingKey(error: string | undefined, json: boolean): void {
  const reason = error ?? 'Missing API key'
  if (json) {
    console.log(
      JSON.stringify({
        ok: false,
        skipped: true,
        reason: 'missing-api-key',
        apiKeyPresent: false,
        error: reason,
        setKeyCommand: SET_KEY_COMMAND,
        runCommand: RUN_COMMAND,
      }),
    )
    return
  }

  console.log('ZooCode live harness test — SKIPPED (no API key)')
  console.log('  apiKeyPresent: false')
  console.log(`  reason:        ${reason}`)
  console.log('')
  console.log(`  Set ${ENV_KEYS.apiKey}, restart VS Code, then run:`)
  console.log(`    ${SET_KEY_COMMAND}`)
  console.log(`    ${RUN_COMMAND}`)
  console.log('')
  console.log('  No request was attempted. The key is never printed.')
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const options = parseArgs(normalize(process.argv.slice(2)))

  if (options.help) {
    printHelp()
    return 0
  }

  if (options.error) {
    console.error(`Invalid arguments: ${options.error}`)
    console.error('Run with --help for usage.')
    return 1
  }

  // Pick up a gitignored ZooCode/.env before resolving config (env vars win).
  loadDotenv()

  const loaded = loadConfig()
  if (!loaded.ok || !loaded.data) {
    reportMissingKey(loaded.error, options.json)
    return 2
  }

  const config = loaded.data
  const model = options.model ?? config.model
  const maxSteps = options.maxSteps ?? config.maxSteps

  const recording = createRecordingClient(
    createDeepSeekClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
  )
  const collector = createCollector()

  const startedAt = Date.now()
  const result = await runAgent({
    llm: recording.client,
    tools: createCoreTools(),
    messages: createMessages(options.task, SYSTEM_PROMPT),
    maxSteps,
    model,
    cwd: REPO_ROOT,
    onEvent: collector.onEvent,
  })
  const durationMs = Date.now() - startedAt

  const events = collector.events
  const toolsUsed = events.toolCalls.map((call) => call.tool)
  const usedAtLeastOneTool = toolsUsed.length > 0
  const finalNonEmpty = result.final.trim().length > 0
  const pass = result.ok && usedAtLeastOneTool && finalNonEmpty

  // Accounting is a by-product of a completed run: it happens once, before the
  // report is rendered, so BOTH --json and human output lead to the same ledger.
  recordRunUsage({
    model,
    steps: result.steps,
    durationMs,
    ok: pass,
    label: options.task,
    recorder: recording,
  })

  const report: LiveReport = {
    ok: result.ok,
    apiKeyPresent: true,
    model,
    task: options.task,
    cwd: REPO_ROOT,
    steps: result.steps,
    durationMs,
    llmRequests: events.llmRequests,
    llmResponses: events.llmResponses,
    toolCallCount: toolsUsed.length,
    toolsUsed,
    uniqueTools: [...new Set(toolsUsed)],
    usedAtLeastOneTool,
    final: result.final,
    finalNonEmpty,
    usage: {
      promptTokens: recording.usage.promptTokens,
      completionTokens: recording.usage.completionTokens,
    },
    toolResults: events.toolResults.map((record) => ({
      step: record.step,
      tool: record.tool,
      ok: record.ok,
      content: truncate(record.content, 200),
    })),
    eventErrors: events.errors,
    error: result.error ?? null,
    pass,
  }

  if (options.json) {
    console.log(JSON.stringify(report))
  } else {
    console.log(renderHuman(report))
    if (!pass) {
      console.error('')
      console.error(
        !result.ok
          ? `Diagnostic: the run did not succeed${result.error ? ` — ${result.error}` : ''}.`
          : !usedAtLeastOneTool
            ? 'Diagnostic: the model answered without calling any tool (no live tool round-trip verified).'
            : 'Diagnostic: the run succeeded but produced empty final text.',
      )
    }
  }

  return pass ? 0 : 1
}

// NOTE: set `process.exitCode` instead of calling `process.exit()`.
// Calling exit() while libuv is still tearing down async handles triggers a
// fatal assertion on Windows (`UV_HANDLE_CLOSING`, src/win/async.c) that aborts
// the process with code -1073740791 instead of the documented 0/1/2 contract.
// `bin/zoocode.ts` uses the same approach for the same reason.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Live test crashed: ${message}`)
    process.exitCode = 1
  })
