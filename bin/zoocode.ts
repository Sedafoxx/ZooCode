#!/usr/bin/env tsx
/**
 * ZooCode CLI — the L4 surface of the homegrown agent harness.
 *
 * This file contains NO agent logic of its own. It parses argv, wires the
 * locked modules together, and translates their results into exit codes:
 *
 *   L4  bin/zoocode.ts   ← you are here (argument parsing, rendering, exit codes)
 *   L3  lib/subagent.ts  runParallel / toolsForTask
 *   L2  lib/harness.ts   runAgent (the agentic loop)
 *   L1  lib/llm.ts       LlmClient seam (DeepSeek + scriptable mock)
 *       lib/tools.ts     ToolDef registry (createCoreTools)
 *   L0  lib/types.ts     the contract
 *       lib/config.ts    env/override resolution
 *
 * Dependencies are Node built-ins only (`node:readline`, `node:process`,
 * `node:child_process`, `node:fs`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { DEFAULT_MODEL, loadConfig, type ZooConfig } from '../lib/config.js'
import type { ContextBudgetOptions, ContextStats } from '../lib/context-budget.js'
import { runDoctor } from '../lib/doctor.js'
import { loadDotenv } from '../lib/dotenv.js'
import { getProjectSummary } from '../lib/files.js'
import { createMessages, DEFAULT_MAX_STEPS, runAgent } from '../lib/harness.js'
import {
  DEFAULT_IMPROVE_MAX_STEPS,
  DEFAULT_VERIFY_COMMAND,
  runImprovement,
} from '../lib/improve.js'
import { createDeepSeekClient, createMockLlmClient } from '../lib/llm.js'
import * as logger from '../lib/logger.js'
import { searchProjects, type SearchOptions } from '../lib/search.js'
import { runParallel } from '../lib/subagent.js'
import { createCoreTools, toolSummaries } from '../lib/tools.js'
import {
  getUsageFile,
  loadPricing,
  makeRunId,
  readUsage,
  recordUsage,
  summarizeUsage,
  type UsageEntry,
  type UsageTotals,
} from '../lib/usage.js'
import {
  createExecPolicy,
  describePolicy,
  EXEC_POLICY_MODES,
  execPolicyFromEnv,
  type ApprovalRequest,
  type ExecPolicy,
  type ExecPolicyMode,
} from '../lib/policy.js'
import type {
  AgentEvent,
  ChatMessage,
  LlmClient,
  LlmRequest,
  LlmResponse,
  RunAgentOptions,
  SubTask,
} from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Mock scripting                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Fixed response used by `--mock` for one-shot runs, so `agent`/`run` complete
 * end-to-end with NO API key.
 */
const MOCK_AGENT_RESPONSES = [
  {
    content:
      'Hello from the scripted mock LLM — the harness completed a full step with no API key.',
  },
]

/**
 * Task prefix that turns the scripted mock into a one-shot `run_command` probe:
 * `mock-run: node --version`. Used by the hermetic CLI tests
 * ([`tests/cli.test.ts`](../tests/cli.test.ts)) to exercise the REAL
 * `run_command` policy path with no network and no API key. A normal prompt
 * never matches, so ordinary `--mock` runs are unchanged.
 */
const MOCK_RUN_PREFIX = 'mock-run:'

/** The probe command a `--mock` task asks for, if any. */
function mockProbeCommand(req: LlmRequest): string | undefined {
  const lastUser = [...req.messages].reverse().find((message) => message.role === 'user')
  const content = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (!content.startsWith(MOCK_RUN_PREFIX)) return undefined
  const command = content.slice(MOCK_RUN_PREFIX.length).trim()
  return command.length > 0 ? command : undefined
}

/**
 * Task prefix for a multi-step, large-output probe: `mock-long: 3` asks the
 * mock to issue three `read_file` calls on a big tracked repo file and then
 * finish. It exists so the hermetic CLI tests can exercise the REAL
 * context-budget path offline: the transcript quickly exceeds a small
 * `--context-budget`, so a step genuinely prunes. A normal prompt never matches,
 * so ordinary `--mock` runs are unchanged.
 */
const MOCK_LONG_PREFIX = 'mock-long:'

/** The tracked file the probe reads; big enough to be truncated at 40k chars. */
const MOCK_LONG_FILE = 'package-lock.json'

/** How many large reads a `mock-long: <n>` task asks for (default 1, min 1). */
function mockLongRounds(req: LlmRequest): number | undefined {
  const firstUser = req.messages.find((message) => message.role === 'user')
  const content = typeof firstUser?.content === 'string' ? firstUser.content : ''
  if (!content.startsWith(MOCK_LONG_PREFIX)) return undefined
  const raw = content.slice(MOCK_LONG_PREFIX.length).trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * Scripted client for `--mock` one-shot runs.
 *
 * - normal task → the canned {@link MOCK_AGENT_RESPONSES} text (unchanged)
 * - `mock-run: <command>` → ask the harness to run `<command>` once, then echo
 *   the tool's report back as the final answer
 * - `mock-long: <n>` → issue `<n>` large `read_file` calls, then answer
 */
function createMockAgentClient(): LlmClient {
  let probeIssued = false
  // Counted in the closure, NOT derived from the transcript: the outbound
  // transcript may have had groups pruned away, and progress must not depend on
  // what survived pruning.
  let longIssued = 0
  return createMockLlmClient((req: LlmRequest): LlmResponse => {
    const longRounds = mockLongRounds(req)
    if (longRounds !== undefined) {
      if (longIssued < longRounds) {
        const index = longIssued
        longIssued += 1
        return {
          content: null,
          toolCalls: [
            { id: `mock-long-${index}`, name: 'read_file', args: { path: MOCK_LONG_FILE } },
          ],
        }
      }
      return { content: `mock-long: read ${MOCK_LONG_FILE} ${longIssued} time(s)` }
    }

    const command = mockProbeCommand(req)
    if (command !== undefined && !probeIssued) {
      probeIssued = true
      return {
        content: null,
        toolCalls: [{ id: 'mock-run-1', name: 'run_command', args: { command } }],
      }
    }
    const toolMessage = [...req.messages].reverse().find((message) => message.role === 'tool')
    if (toolMessage !== undefined) return { content: toolMessage.content ?? '' }
    return { content: MOCK_AGENT_RESPONSES[0].content }
  })
}

/** Echo-style scripted response for the interactive `chat --mock` REPL. */
function mockEcho(req: LlmRequest): { content: string } {
  const lastUser = [...req.messages].reverse().find((message) => message.role === 'user')
  return { content: `mock reply to: ${lastUser?.content ?? '(no user message)'}` }
}

/* -------------------------------------------------------------------------- */
/* Arg parsing (hand-rolled, no dependencies)                                 */
/* -------------------------------------------------------------------------- */

interface ParsedArgs {
  options: Map<string, string | boolean>
  positionals: string[]
}

/**
 * Parse `--flag`, `--flag value`, `--flag=value` and bare positionals.
 *
 * A bare `--flag` is a boolean UNLESS it appears in `valueFlags`, in which case
 * the following token is consumed as its value. That explicit list is what keeps
 * `agent "hi" --mock` unambiguous.
 */
function parseArgs(args: string[], valueFlags: readonly string[]): ParsedArgs {
  const options = new Map<string, string | boolean>()
  const positionals: string[] = []

  let index = 0
  while (index < args.length) {
    const token = args[index]

    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals !== -1) {
        options.set(token.slice(0, equals), token.slice(equals + 1))
        index += 1
        continue
      }
      if (valueFlags.includes(token)) {
        const value = args[index + 1]
        if (value === undefined) throw new Error(`Missing value for ${token}`)
        options.set(token, value)
        index += 2
        continue
      }
      options.set(token, true)
      index += 1
      continue
    }

    positionals.push(token)
    index += 1
  }

  return { options, positionals }
}

function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name)
  return typeof value === 'string' ? value : undefined
}

function flagEnabled(parsed: ParsedArgs, name: string): boolean {
  return parsed.options.get(name) === true
}

function flagNumber(parsed: ParsedArgs, name: string): number | undefined {
  const raw = flagValue(parsed, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

/* -------------------------------------------------------------------------- */
/* Context budget wiring                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the `contextBudget` handed to `runAgent` from the flags first, then
 * the config env vars. Returns `undefined` when neither is set so the library
 * default (`DEFAULT_CONTEXT_BUDGET`) applies.
 *
 * `--context-budget` sets the estimated-token ceiling; `--keep-recent` sets how
 * many trailing message groups stay verbatim.
 */
function contextBudgetFrom(
  parsed: ParsedArgs,
  config?: ZooConfig,
): Partial<ContextBudgetOptions> | undefined {
  const budgetTokens = flagNumber(parsed, '--context-budget') ?? config?.contextBudgetTokens
  const keepRecentGroups = flagNumber(parsed, '--keep-recent') ?? config?.contextKeepGroups
  if (budgetTokens === undefined && keepRecentGroups === undefined) return undefined

  const budget: Partial<ContextBudgetOptions> = {}
  if (budgetTokens !== undefined) budget.budgetTokens = budgetTokens
  if (keepRecentGroups !== undefined) budget.keepRecentGroups = keepRecentGroups
  return budget
}

/**
 * One compact line describing what the budget did. Written to **stderr** so
 * `--json` payloads on stdout stay machine-readable. Token counts are
 * estimates, hence the `est.` marker.
 */
function formatContextLine(stats: ContextStats): string {
  return (
    `[context] pruned: ${stats.originalTokens} -> ${stats.finalTokens} est. tokens ` +
    `(${stats.elidedResults} results elided, ${stats.droppedGroups} groups dropped)`
  )
}

/* -------------------------------------------------------------------------- */
/* Execution policy wiring                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The CLI default is stricter than the library default on purpose.
 *
 * `createCoreTools()` with no policy keeps the historical permissive behavior
 * (`mode: 'allow'`), while the CLI — which has a human to tell — defaults to
 * `allowlist`, so an agent can only run executables the workshop allowlist names.
 */
const CLI_DEFAULT_EXEC_MODE: ExecPolicyMode = 'allowlist'

function isExecPolicyMode(value: string): value is ExecPolicyMode {
  return (EXEC_POLICY_MODES as readonly string[]).includes(value)
}

/**
 * Resolve the mode from `ZOO_EXEC_POLICY`, falling back to the CLI default.
 *
 * A typo in the env var must never silently loosen execution: unknown values are
 * reported on stderr and treated as "unset" (→ the strict CLI default).
 */
function execModeFromEnv(): ExecPolicyMode {
  const raw = process.env.ZOO_EXEC_POLICY
  if (typeof raw !== 'string' || raw.trim().length === 0) return CLI_DEFAULT_EXEC_MODE
  if (!isExecPolicyMode(raw.trim().toLowerCase())) {
    process.stderr.write(
      `[exec-policy] ignoring unknown ZOO_EXEC_POLICY="${raw}" — using "${CLI_DEFAULT_EXEC_MODE}"\n`,
    )
    return CLI_DEFAULT_EXEC_MODE
  }
  return execPolicyFromEnv()
}

/**
 * Effective mode for a command. Precedence:
 *   `--no-exec` > `--exec-policy <mode>` > `--allow-exec` > `ZOO_EXEC_POLICY` >
 *   CLI default (`allowlist`).
 */
function resolveExecMode(
  parsed: ParsedArgs,
): { ok: true; mode: ExecPolicyMode } | { ok: false; error: string } {
  if (flagEnabled(parsed, '--no-exec')) return { ok: true, mode: 'deny' }

  const explicit = flagValue(parsed, '--exec-policy')
  if (explicit !== undefined) {
    const candidate = explicit.trim().toLowerCase()
    if (isExecPolicyMode(candidate)) return { ok: true, mode: candidate }
    return {
      ok: false,
      error: `Unknown --exec-policy value "${explicit}". Expected one of: ${EXEC_POLICY_MODES.join(', ')}`,
    }
  }

  if (flagEnabled(parsed, '--allow-exec')) return { ok: true, mode: 'allow' }
  return { ok: true, mode: execModeFromEnv() }
}

/**
 * Resolve the policy for a non-interactive command (`agent` / `run`) and
 * announce it on **stderr** (so `--json` stays clean on stdout).
 *
 * `ask` cannot work here — there is nobody to ask — so it fails closed with the
 * explicit fix instead of silently permitting (or silently refusing) commands.
 */
function nonInteractivePolicy(
  parsed: ParsedArgs,
): { ok: true; policy: ExecPolicy } | { ok: false; error: string } {
  const resolved = resolveExecMode(parsed)
  if (!resolved.ok) return resolved

  if (resolved.mode === 'ask') {
    return {
      ok: false,
      error:
        '--exec-policy ask needs an interactive approver and cannot be used with agent/run; use --exec-policy allowlist or --allow-exec instead.',
    }
  }

  const policy = createExecPolicy({ mode: resolved.mode })
  process.stderr.write(`[exec-policy] ${describePolicy(policy)}\n`)
  return { ok: true, policy }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Flatten to a single trimmed line and cap its length for terminal output. */
function oneLine(text: string, max = 160): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

/** Quote one argument for the platform shell (only used for pass-throughs). */
function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Read all of stdin as UTF-8 (used by `run -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Validate/normalize the JSON payload accepted by `run`. */
function parseTasks(raw: string): SubTask[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array of sub-tasks, e.g. [{"id":"a","prompt":"hi"}]')
  }
  return parsed.map((entry, index): SubTask => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`sub-task ${index} must be an object`)
    }
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error(`sub-task ${index} requires a non-empty string "id"`)
    }
    if (typeof record.prompt !== 'string' || record.prompt.length === 0) {
      throw new Error(`sub-task ${index} requires a non-empty string "prompt"`)
    }
    const task: SubTask = { id: record.id, prompt: record.prompt }
    if (typeof record.system === 'string') task.system = record.system
    if (Array.isArray(record.tools)) {
      task.tools = record.tools.filter((name): name is string => typeof name === 'string')
    }
    return task
  })
}

/* -------------------------------------------------------------------------- */
/* LLM session wiring                                                         */
/* -------------------------------------------------------------------------- */

interface Session {
  llm: LlmClient
  config?: ZooConfig
}

/** Build a client from config, or the scripted mock when `mock` is set. */
function resolveSession(mock: boolean): { ok: true; session: Session } | { ok: false; error: string } {
  if (mock) {
    return { ok: true, session: { llm: createMockAgentClient() } }
  }

  const loaded = loadConfig()
  if (!loaded.ok || !loaded.data) {
    return { ok: false, error: loaded.error ?? 'Failed to load configuration' }
  }

  const config = loaded.data
  return {
    ok: true,
    session: { llm: createDeepSeekClient({ apiKey: config.apiKey, baseUrl: config.baseUrl }), config },
  }
}

/** Print a config failure plus the fix hint, and return the exit code to use. */
function reportConfigError(message: string): number {
  logger.error(message)
  logger.info('Hint: set DEEPSEEK_API_KEY in your environment, or pass --mock to run without an API key.')
  return 1
}

/* -------------------------------------------------------------------------- */
/* Usage recording                                                            */
/* -------------------------------------------------------------------------- */

interface UsageRecorder {
  llm: LlmClient
  totals: { requests: number; promptTokens: number; completionTokens: number }
}

/**
 * Wrap a client so token usage can be accumulated per `chat()` call — the
 * harness event stream deliberately carries no usage. Mirrors
 * `createRecordingClient` in [`scripts/live-test.ts`](scripts/live-test.ts).
 */
function withUsageRecording(inner: LlmClient): UsageRecorder {
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0 }
  const llm: LlmClient = {
    async chat(req: LlmRequest): Promise<LlmResponse> {
      totals.requests += 1
      const response = await inner.chat(req)
      totals.promptTokens += response.usage?.promptTokens ?? 0
      totals.completionTokens += response.usage?.completionTokens ?? 0
      return response
    },
  }
  return { llm, totals }
}

interface UsageRecordInput {
  kind: 'agent' | 'chat' | 'parallel'
  model: string
  steps: number
  durationMs: number
  ok: boolean
  label?: string
  recorder: UsageRecorder
}

/**
 * Persist one aggregate ledger entry, unless recording is a no-op.
 *
 * Two documented skips keep the local ledger meaningful:
 *  - `ZOO_NO_USAGE=1` — an explicit opt-out for scripts, CI, and the hermetic
 *    CLI smoke tests, which must never write to the repo's real `.zoo/`.
 *  - **zero total tokens** — a `--mock` run (or any run whose client reports no
 *    usage) has nothing to account for, so it never pollutes the ledger.
 */
function persistUsage(input: UsageRecordInput): void {
  if (process.env.ZOO_NO_USAGE === '1') return

  const { promptTokens, completionTokens } = input.recorder.totals
  const totalTokens = promptTokens + completionTokens
  if (totalTokens === 0) return

  const entry: UsageEntry = {
    ts: new Date().toISOString(),
    kind: input.kind,
    model: input.model,
    runId: makeRunId(),
    steps: input.steps,
    promptTokens,
    completionTokens,
    totalTokens,
    durationMs: input.durationMs,
    ok: input.ok,
  }
  const label = input.label === undefined ? '' : oneLine(input.label, 80)
  if (label.length > 0) entry.label = label

  const result = recordUsage(entry)
  if (!result.ok) {
    logger.warn(`Failed to record usage: ${result.error ?? 'unknown error'}`)
  }
}

/* -------------------------------------------------------------------------- */
/* Event rendering (--events → stderr)                                        */
/* -------------------------------------------------------------------------- */

function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'llm_request':
      return `[step ${event.step}] → llm_request (${event.messageCount} messages)`
    case 'context_pruned':
      return (
        `[step ${event.step}] context pruned: ${event.stats.originalTokens} -> ` +
        `${event.stats.finalTokens} est. tokens (${event.stats.elidedResults} results elided, ` +
        `${event.stats.droppedGroups} groups dropped)`
      )
    case 'llm_response':
      return `[step ${event.step}] ← llm_response (content=${event.content === null ? 'null' : 'set'}, toolCalls=${event.toolCallCount})`
    case 'tool_call':
      return `[step ${event.step}] → tool_call ${event.tool} ${JSON.stringify(event.args)}`
    case 'tool_result':
      return `[step ${event.step}] ← tool_result ${event.tool} ok=${event.ok} ${oneLine(event.content)}`
    case 'done':
      return `[done] steps=${event.steps} ${oneLine(event.final)}`
    case 'error':
      return `[step ${event.step}] error: ${event.error}`
    default:
      return '[unhandled event]'
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/** `zoocode tools [--json]` */
function cmdTools(args: string[]): number {
  const parsed = parseArgs(args, [])
  const summaries = toolSummaries(createCoreTools())

  if (flagEnabled(parsed, '--json')) {
    console.log(JSON.stringify(summaries, null, 2))
    return 0
  }

  logger.header(`Core tools (${summaries.length})`)
  const width = summaries.reduce((max, entry) => Math.max(max, entry.name.length), 0)
  for (const entry of summaries) {
    console.log(`  ${entry.name.padEnd(width)}  ${oneLine(entry.description, 200)}`)
  }
  return 0
}

/** `zoocode agent "<task>" [--system <text>] [--max-steps N] [--cwd <path>] [--context-budget <tokens>] [--keep-recent <n>] [--mock] [--json] [--events] [--exec-policy <mode>]` */
async function cmdAgent(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    '--system',
    '--max-steps',
    '--cwd',
    '--exec-policy',
    '--context-budget',
    '--keep-recent',
  ])
  const task = parsed.positionals[0]
  if (task === undefined) {
    logger.error('agent requires a task prompt')
    logger.dim('usage: zoocode agent "<task>" [--system <text>] [--max-steps N] [--cwd <path>] [--context-budget <tokens>] [--keep-recent <n>] [--mock] [--json] [--events] [--exec-policy <mode>]')
    return 1
  }

  const mock = flagEnabled(parsed, '--mock')
  const asJson = flagEnabled(parsed, '--json')
  const streamEvents = flagEnabled(parsed, '--events')
  const system = flagValue(parsed, '--system')
  const cwd = flagValue(parsed, '--cwd')
  const maxSteps = flagNumber(parsed, '--max-steps')

  // Resolve (and announce) the exec policy before anything can run a command.
  const policyResult = nonInteractivePolicy(parsed)
  if (!policyResult.ok) {
    logger.error(policyResult.error)
    return 1
  }

  const resolved = resolveSession(mock)
  if (!resolved.ok) return reportConfigError(resolved.error)
  const { llm, config } = resolved.session
  const recorder = withUsageRecording(llm)

  const options: RunAgentOptions = {
    llm: recorder.llm,
    tools: createCoreTools({ policy: policyResult.policy }),
    messages: createMessages(task, system),
  }
  const effectiveMaxSteps = maxSteps ?? config?.maxSteps
  if (effectiveMaxSteps !== undefined) options.maxSteps = effectiveMaxSteps
  if (cwd !== undefined) options.cwd = cwd
  if (config?.model !== undefined) options.model = config.model
  const contextBudget = contextBudgetFrom(parsed, config)
  if (contextBudget !== undefined) options.contextBudget = contextBudget
  if (streamEvents) {
    options.onEvent = (event: AgentEvent): void => {
      process.stderr.write(`${describeEvent(event)}\n`)
    }
  }

  const startedAt = Date.now()
  const result = await runAgent(options)

  // At least one step pruned its outbound transcript: report it on stderr so the
  // JSON payload on stdout stays clean.
  if (result.context !== undefined) {
    process.stderr.write(`${formatContextLine(result.context)}\n`)
  }

  persistUsage({
    kind: 'agent',
    model: config?.model ?? DEFAULT_MODEL,
    steps: result.steps,
    durationMs: Date.now() - startedAt,
    ok: result.ok,
    label: task,
    recorder,
  })

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          final: result.final,
          steps: result.steps,
          error: result.error ?? null,
          // Last applied stats, or null when nothing was pruned.
          context: result.context ?? null,
        },
        null,
        2,
      ),
    )
  } else if (result.ok) {
    console.log(result.final)
  } else {
    if (result.final.length > 0) console.log(result.final)
    logger.error(result.error ?? 'agent run failed')
  }

  return result.ok ? 0 : 1
}

/** `zoocode chat [--mock] [--system <text>] [--context-budget <tokens>] [--keep-recent <n>] [--exec-policy <mode>]` */
async function cmdChat(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ['--system', '--exec-policy', '--context-budget', '--keep-recent'])
  const mock = flagEnabled(parsed, '--mock')
  const system = flagValue(parsed, '--system')

  const resolvedMode = resolveExecMode(parsed)
  if (!resolvedMode.ok) {
    logger.error(resolvedMode.error)
    return 1
  }

  let llm: LlmClient
  let config: ZooConfig | undefined
  if (mock) {
    llm = createMockLlmClient(mockEcho)
  } else {
    const resolved = resolveSession(false)
    if (!resolved.ok) return reportConfigError(resolved.error)
    llm = resolved.session.llm
    config = resolved.session.config
  }

  // One aggregate record for the whole REPL session, not one per turn.
  const recorder = withUsageRecording(llm)
  llm = recorder.llm
  const sessionStartedAt = Date.now()
  let chatSteps = 0
  let chatOk = true

  // ONE transcript for the whole session; each turn extends it.
  let transcript: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system }]
  const maxSteps = config?.maxSteps ?? DEFAULT_MAX_STEPS
  const contextBudget = contextBudgetFrom(parsed, config)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const buffered: string[] = []
  let waiting: ((line: string | null) => void) | undefined
  let closed = false

  rl.on('line', (line) => {
    if (waiting) {
      const resolveLine = waiting
      waiting = undefined
      resolveLine(line)
      return
    }
    buffered.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (waiting) {
      const resolveLine = waiting
      waiting = undefined
      resolveLine(null)
    }
  })

  const nextLine = (): Promise<string | null> => {
    const ready = buffered.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    if (closed) return Promise.resolve(null)
    return new Promise((resolveLine) => {
      waiting = resolveLine
    })
  }

  /**
   * Interactive approver for `--exec-policy ask`. It reuses the REPL's own
   * readline queue (`nextLine`), which is safe because the REPL loop is
   * suspended inside `runAgent` whenever a tool asks for approval. Empty input
   * and EOF both mean NO.
   */
  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    process.stdout.write(
      `\n[exec-policy ask] ${req.tool} wants to run in ${req.cwd || '(working directory)'}:\n` +
        `  ${req.command}\nApprove? [y/N] `,
    )
    const line = await nextLine()
    if (line === null) {
      process.stdout.write('\n')
      return false
    }
    const answer = line.trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  const policy = createExecPolicy(
    resolvedMode.mode === 'ask'
      ? { mode: resolvedMode.mode, approve }
      : { mode: resolvedMode.mode },
  )

  logger.info(`zoocode chat${mock ? ' (mock)' : ''} — type /exit to quit`)
  logger.dim(describePolicy(policy))
  try {
    for (;;) {
      process.stdout.write('you> ')
      const line = await nextLine()
      if (line === null) {
        process.stdout.write('\n')
        break
      }
      const input = line.trim()
      if (input.length === 0) continue
      if (input === '/exit' || input === '/quit') break

      transcript.push({ role: 'user', content: input })

      const options: RunAgentOptions = {
        llm,
        tools: createCoreTools({ policy }),
        messages: transcript,
        maxSteps,
      }
      if (config?.model !== undefined) options.model = config.model
      if (contextBudget !== undefined) options.contextBudget = contextBudget

      const result = await runAgent(options)
      // Adopt the returned transcript so history accumulates across turns. The
      // context budget only shrank the OUTBOUND request, so the stored history
      // stays complete.
      transcript = result.messages
      chatSteps += result.steps
      if (!result.ok) chatOk = false

      // Per-turn note on stderr (stdout carries the reply).
      if (result.context !== undefined) {
        process.stderr.write(`${formatContextLine(result.context)}\n`)
      }

      if (result.ok) console.log(result.final.length > 0 ? result.final : '(no final text)')
      else logger.error(result.error ?? 'agent run failed')
    }
  } finally {
    rl.close()
  }

  persistUsage({
    kind: 'chat',
    model: config?.model ?? DEFAULT_MODEL,
    steps: chatSteps,
    durationMs: Date.now() - sessionStartedAt,
    ok: chatOk,
    label: 'interactive chat session',
    recorder,
  })

  return 0
}

/** `zoocode run <file.json | -> [--concurrency N] [--context-budget <tokens>] [--keep-recent <n>] [--mock] [--json]` */
async function cmdRun(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    '--concurrency',
    '--exec-policy',
    '--context-budget',
    '--keep-recent',
  ])
  const source = parsed.positionals[0]
  if (source === undefined) {
    logger.error('run requires a JSON file path or "-" for stdin')
    return 1
  }

  const mock = flagEnabled(parsed, '--mock')
  const asJson = flagEnabled(parsed, '--json')

  let raw: string
  try {
    raw = source === '-' ? await readStdin() : readFileSync(source, 'utf-8')
  } catch (err) {
    logger.error(`Failed to read ${source === '-' ? 'stdin' : source}: ${errorMessage(err)}`)
    return 1
  }

  let tasks: SubTask[]
  try {
    tasks = parseTasks(raw)
  } catch (err) {
    logger.error(`Invalid sub-task JSON: ${errorMessage(err)}`)
    return 1
  }

  // Resolve (and announce) the exec policy before any sub-task can run.
  const policyResult = nonInteractivePolicy(parsed)
  if (!policyResult.ok) {
    logger.error(policyResult.error)
    return 1
  }

  const resolved = resolveSession(mock)
  if (!resolved.ok) return reportConfigError(resolved.error)
  const { llm, config } = resolved.session
  const recorder = withUsageRecording(llm)

  const concurrency = flagNumber(parsed, '--concurrency') ?? config?.concurrency
  const contextBudget = contextBudgetFrom(parsed, config)

  const startedAt = Date.now()
  const result = await runParallel(tasks, {
    llm: recorder.llm,
    tools: createCoreTools({ policy: policyResult.policy }),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  })
  persistUsage({
    kind: 'parallel',
    model: config?.model ?? DEFAULT_MODEL,
    steps: result.results.reduce((total, entry) => total + entry.steps, 0),
    durationMs: Date.now() - startedAt,
    ok: result.ok,
    label: tasks.length === 1 ? tasks[0].prompt : `${tasks.length} sub-tasks`,
    recorder,
  })

  // One compact stderr line per sub-task that pruned (stdout stays clean).
  for (const entry of result.results) {
    if (entry.result.context !== undefined) {
      process.stderr.write(`${formatContextLine(entry.result.context)}\n`)
    }
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const entry of result.results) {
      const detail = entry.ok ? oneLine(entry.final, 200) : oneLine(entry.error ?? 'failed', 200)
      console.log(`  [${entry.id}] ${entry.ok ? 'ok  ' : 'fail'} ${detail}`)
    }
    const passed = result.results.filter((entry) => entry.ok).length
    logger.dim(`${passed}/${result.results.length} sub-tasks succeeded`)
    if (result.error !== undefined) logger.error(result.error)
  }

  return result.ok ? 0 : 1
}

/** `zoocode doctor [--json]` */
function cmdDoctor(args: string[]): number {
  const parsed = parseArgs(args, [])
  const result = runDoctor()
  if (!result.ok || !result.data) {
    logger.error(result.error ?? 'doctor failed')
    return 1
  }

  const report = result.data
  if (flagEnabled(parsed, '--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    logger.header('ZooCode doctor')
    for (const check of report.checks) {
      const line = check.detail === undefined ? check.name : `${check.name}: ${check.detail}`
      if (check.status === 'ok') logger.success(line)
      else if (check.status === 'warn') logger.warn(line)
      else logger.error(line)
    }
    logger.dim(`ok=${report.summary.ok} warn=${report.summary.warn} fail=${report.summary.fail} (${report.healthy ? 'healthy' : 'unhealthy'})`)
  }

  return report.healthy ? 0 : 1
}

/** `zoocode analyze <dir> [--json]` */
function cmdAnalyze(args: string[]): number {
  const parsed = parseArgs(args, [])
  const target = parsed.positionals[0]
  if (target === undefined) {
    logger.error('analyze requires a target directory')
    return 1
  }
  if (!existsSync(target)) {
    logger.error(`Directory not found: ${target}`)
    return 1
  }

  let summary: ReturnType<typeof getProjectSummary>
  try {
    summary = getProjectSummary(target)
  } catch (err) {
    logger.error(`Failed to analyze ${target}: ${errorMessage(err)}`)
    return 1
  }

  if (flagEnabled(parsed, '--json')) {
    console.log(JSON.stringify(summary, null, 2))
    return 0
  }

  logger.header(`Analysis: ${target}`)
  logger.info(`Total files: ${summary.files}`)
  logger.info(`Total lines: ${summary.lines}`)
  logger.step('Files by extension')
  const sorted = Object.entries(summary.extensions).sort((a, b) => b[1] - a[1])
  for (const [ext, count] of sorted) {
    logger.info(`.${ext}: ${count} files`)
  }
  logger.success('Analysis complete')
  return 0
}

/** `zoocode search <pattern> [--ext .ts] [--max N] [--project <name>] [--json]` */
function cmdSearch(args: string[]): number {
  const parsed = parseArgs(args, ['--ext', '--max', '--project'])
  const pattern = parsed.positionals[0]
  if (pattern === undefined) {
    logger.error('search requires a pattern')
    return 1
  }

  const options: SearchOptions = {}
  const ext = flagValue(parsed, '--ext')
  const max = flagNumber(parsed, '--max')
  const project = flagValue(parsed, '--project')
  if (ext !== undefined) options.ext = ext
  if (max !== undefined) options.max = max
  if (project !== undefined) options.project = project

  const result = searchProjects(pattern, options)
  if (!result.ok || !result.data) {
    logger.error(result.error ?? 'search failed')
    return 1
  }

  if (flagEnabled(parsed, '--json')) {
    console.log(JSON.stringify(result.data, null, 2))
    return 0
  }

  const { hits, durationMs } = result.data
  if (hits.length === 0) {
    logger.warn(`No matches for /${pattern}/`)
    return 0
  }

  logger.header(`Search: ${pattern}`)
  for (const hit of hits) {
    console.log(`  ${hit.project}/${hit.file}:${hit.line}: ${hit.text}`)
  }
  logger.dim(`${hits.length} hits in ${durationMs}ms`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* Usage command                                                              */
/* -------------------------------------------------------------------------- */

/** Fixed-width duration for the usage table. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}

function totalsHeaderRow(): string {
  return [
    'name'.padEnd(24),
    'runs'.padStart(5),
    'steps'.padStart(7),
    'prompt'.padStart(11),
    'completion'.padStart(12),
    'total'.padStart(11),
    'est.cost'.padStart(12),
    'duration'.padStart(10),
  ].join(' ')
}

function totalsRow(name: string, totals: UsageTotals): string {
  return [
    name.padEnd(24),
    String(totals.runs).padStart(5),
    String(totals.steps).padStart(7),
    String(totals.promptTokens).padStart(11),
    String(totals.completionTokens).padStart(12),
    String(totals.totalTokens).padStart(11),
    `$${totals.estimatedCostUsd.toFixed(4)}`.padStart(12),
    formatDuration(totals.durationMs).padStart(10),
  ].join(' ')
}

/**
 * `zoocode usage [--json] [--days N] [--model <name>]`
 *
 * READ-ONLY: it only ever calls `readUsage` / `loadPricing`, never `recordUsage`.
 */
function cmdUsage(args: string[]): number {
  const parsed = parseArgs(args, ['--days', '--model'])
  const asJson = flagEnabled(parsed, '--json')
  const rawDays = flagNumber(parsed, '--days')
  const days = rawDays === undefined ? 7 : Math.max(0, Math.floor(rawDays))
  const modelFilter = flagValue(parsed, '--model')

  const read = readUsage()
  if (!read.ok) {
    logger.error(read.error ?? 'Failed to read usage ledger')
    return 1
  }

  const all = read.data ?? []
  const entries = modelFilter === undefined ? all : all.filter((entry) => entry.model === modelFilter)
  const now = new Date()
  const summary = summarizeUsage(entries, { days, now, pricing: loadPricing().data })
  summary.skippedLines = read.skippedLines

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
    return 0
  }

  const windowStart = new Date(now.getTime() - days * 86_400_000)
  logger.header('Usage & cost (estimate)')
  logger.info(`Ledger: ${getUsageFile()}`)
  logger.info(`Window: last ${days} day(s) — ${windowStart.toISOString()} → ${now.toISOString()}`)
  if (modelFilter !== undefined) logger.info(`Filtered to model: ${modelFilter}`)
  const skippedNote = read.skippedLines > 0 ? ` (${read.skippedLines} corrupt line(s) skipped)` : ''
  logger.info(`Recorded runs: ${summary.entries}${skippedNote}`)

  if (summary.entries === 0) {
    logger.dim('No usage recorded in this window. Run an agent / chat / run task first.')
  } else {
    logger.step('Overall')
    console.log(totalsHeaderRow())
    console.log(totalsRow('overall', summary.overall))

    logger.step('By model')
    console.log(totalsHeaderRow())
    const models = Object.entries(summary.byModel).sort(
      (a, b) => b[1].totalTokens - a[1].totalTokens,
    )
    for (const [model, totals] of models) {
      console.log(totalsRow(model, totals))
    }

    logger.step('By day')
    console.log(totalsHeaderRow())
    for (const [day, totals] of Object.entries(summary.byDay)) {
      console.log(totalsRow(day, totals))
    }
  }

  if (summary.unpricedModels.length > 0) {
    logger.warn(
      `Unpriced models (cost reported as 0, NOT "free"): ${summary.unpricedModels.join(', ')}`,
    )
  }
  logger.dim('Estimated cost is NOT billing — override the table in .zoo/pricing.json.')
  return 0
}

/**
 * `zoocode improve "<goal>" [--max-steps N] [--verify-cmd "<cmd>"] [--commit] [--dry-run] [--no-branch] [--json]`
 *
 * The self-improvement loop: it edits THIS repository's own source. Everything
 * risky about that is handled by [`lib/improve.ts`](../lib/improve.ts) — the CLI
 * only wires it up and renders the report. Three points are decided HERE:
 *
 *  - a REAL API key is mandatory (no `--mock` fallback: the mock cannot edit a
 *    repository meaningfully, and silently faking an improvement would be worse
 *    than failing);
 *  - the exec policy is FORCED to `allowlist`, ignoring `--exec-policy`,
 *    `--allow-exec` and `ZOO_EXEC_POLICY` — this command has no "trust me" mode;
 *  - `--commit` is opt-in, so the default outcome is a branch a human reviews.
 */
async function cmdImprove(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    '--max-steps',
    '--verify-cmd',
    '--context-budget',
    '--keep-recent',
  ])
  const goal = parsed.positionals[0]
  if (goal === undefined) {
    logger.error('improve requires a goal prompt')
    logger.dim(
      `usage: zoocode improve "<goal>" [--max-steps N] [--verify-cmd "<cmd>"] [--context-budget <tokens>] [--keep-recent <n>] [--commit] [--dry-run] [--no-branch] [--json]`,
    )
    return 1
  }

  const asJson = flagEnabled(parsed, '--json')

  // A real key is required: never silently fall back to the scripted mock.
  const loaded = loadConfig()
  if (!loaded.ok || !loaded.data) {
    logger.error(loaded.error ?? 'Failed to load configuration')
    logger.info(
      'improve needs a real model: set DEEPSEEK_API_KEY in the environment (or in a .env file). ' +
        'There is no --mock fallback for this command.',
    )
    return 1
  }
  const config = loaded.data

  const maxSteps = flagNumber(parsed, '--max-steps') ?? config.maxSteps
  // Without this, `--context-budget` / `ZOO_CONTEXT_BUDGET_TOKENS` were silently
  // ignored on the improve path and the loop always used the library default.
  const contextBudget = contextBudgetFrom(parsed, config)
  const verifyCommand = flagValue(parsed, '--verify-cmd') ?? DEFAULT_VERIFY_COMMAND
  const commit = flagEnabled(parsed, '--commit')
  const dryRun = flagEnabled(parsed, '--dry-run')
  const createBranch = !flagEnabled(parsed, '--no-branch')

  // Forced strict policy: say so out loud, regardless of the other exec flags.
  const policy = createExecPolicy({ mode: 'allowlist' })
  logger.info(`[improve] exec policy forced to allowlist: ${describePolicy(policy)}`)
  logger.warn(
    'improve edits THIS repository (its own source). It refuses a dirty tree, isolates its work ' +
      'on a zoo/improve-<timestamp> branch, gates on the verify command, and does NOT commit ' +
      'unless --commit is passed.',
  )
  if (dryRun) {
    logger.info('[improve] dry run: preflight only — no branch, no agent, no writes')
  }

  const recorder = withUsageRecording(
    createDeepSeekClient({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
  )
  const startedAt = Date.now()

  const report = await runImprovement({
    llm: recorder.llm,
    goal,
    maxSteps,
    verifyCommand,
    commit,
    dryRun,
    createBranch,
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  })

  persistUsage({
    kind: 'agent',
    model: config.model,
    steps: report.agent?.steps ?? 0,
    durationMs: Date.now() - startedAt,
    ok: report.ok,
    label: `improve: ${oneLine(goal, 60)}`,
    recorder,
  })

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }

  logger.header('Improve — self-modification report')
  logger.info(`Goal: ${goal}`)
  logger.info(
    `Preflight: git repo=${report.preflight.isGitRepo ? 'yes' : 'no'} · clean=${
      report.preflight.clean ? 'yes' : 'no'
    }`,
  )
  for (const note of report.preflight.notes) logger.dim(`  · ${note}`)
  if (report.branch !== undefined) logger.info(`Branch: ${report.branch}`)

  if (report.agent !== undefined) {
    logger.step('Agent')
    const status = report.agent.ok
      ? 'finished'
      : `failed (${report.agent.error ?? 'unknown error'})`
    logger.info(`steps: ${report.agent.steps} · ${status}`)
    if (report.agent.final.length > 0) console.log(`  ${oneLine(report.agent.final, 300)}`)
  }

  logger.step(`Files changed (${report.changedFiles.length})`)
  if (report.changedFiles.length === 0) logger.dim('  (no files changed)')
  for (const file of report.changedFiles) console.log(`  ${file}`)

  logger.step('Diff stat')
  console.log(report.diffStat.length > 0 ? report.diffStat : '  (empty — no tracked changes)')

  if (report.verify !== undefined) {
    logger.step('Verification (mandatory gate)')
    logger.info(`command: ${report.verify.command}`)
    const summary = `exit ${report.verify.exitCode} in ${formatDuration(report.verify.durationMs)}`
    if (report.verify.ok) logger.success(`verify PASSED (${summary})`)
    else logger.error(`verify FAILED (${summary})`)
    if (!report.verify.ok && report.verify.tail.length > 0) {
      logger.dim('  last output lines:')
      for (const line of report.verify.tail.split('\n').slice(-15)) console.log(`  ${line}`)
    }
  }

  logger.step('Commit')
  if (report.committed) {
    logger.warn('COMMITTED — the change is on the branch as a commit; review it before merging.')
  } else {
    logger.warn(
      'NOT COMMITTED — nothing was committed. The work sits on the branch (see above) awaiting review.',
    )
  }

  if (report.error !== undefined) logger.error(report.error)
  if (report.ok) logger.success('Improvement finished with a GREEN verify gate.')
  else logger.error('Improvement did NOT complete successfully.')

  return report.ok ? 0 : 1
}

/** Passthrough to an existing script, inheriting stdio so colors/TTY survive. */
function cmdPassthrough(script: string, args: string[]): number {
  const command = ['npx', 'tsx', shellQuote(script), ...args.map(shellQuote)].join(' ')
  const result = spawnSync(command, { stdio: 'inherit', shell: true })
  if (result.error) {
    logger.error(`Failed to run ${script}: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const USAGE = `
  zoocode — the ZooCode agent harness CLI

  Usage:
    zoocode tools [--json]
    zoocode agent "<task>" [--system <text>] [--max-steps N] [--cwd <path>] [--context-budget <tokens>] [--keep-recent <n>] [--mock] [--json] [--events] [--exec-policy <mode>] [--allow-exec] [--no-exec]
    zoocode chat [--mock] [--system <text>] [--context-budget <tokens>] [--keep-recent <n>] [--exec-policy <mode>] [--allow-exec] [--no-exec]
    zoocode run <file.json | -> [--concurrency N] [--context-budget <tokens>] [--keep-recent <n>] [--mock] [--json] [--exec-policy <mode>] [--allow-exec] [--no-exec]
    zoocode doctor [--json]
    zoocode analyze <dir> [--json]
    zoocode search <pattern> [--ext .ts] [--max N] [--project <name>] [--json]
    zoocode usage [--json] [--days N] [--model <name>]
    zoocode improve "<goal>" [--max-steps N] [--verify-cmd "<cmd>"] [--commit] [--dry-run] [--no-branch] [--json]
    zoocode commit [args...]
    zoocode scaffold [args...]
    zoocode help

  Commands:
    tools     List the core tools (name + description)
    agent     Run one task through the agent loop
    chat      Interactive REPL over one running transcript
    run       Run a JSON array of sub-tasks in parallel
    doctor    Check the local toolchain and repo state
    analyze   Summarize a project directory
    search    Regex-search across projects
    usage     Show recorded token usage & estimated cost (.zoo/usage.jsonl)
    improve   Improve THIS repository with the agent (WARNING: edits this repository's own source)
    commit    Passthrough to scripts/commit.ts
    scaffold  Passthrough to scripts/scaffold.ts
    help      Show this message

  Flags:
    --mock      Use a scripted mock LLM (no API key required)
    --json      Emit machine-readable JSON
    --events    Stream agent events to stderr (agent only)

  Context management for agent / chat / run:
    The loop re-sends the whole transcript every step, so before each request the
    outbound transcript is bounded (the transcript RETURNED to you is untouched).
    Pruning works on whole message groups — an assistant message with toolCalls
    plus all of its tool results travel together, always: a long tool result is
    elided oldest-first (its content replaced by a short marker, the message and
    its toolCallId stay), and only if that is not enough are whole groups dropped
    oldest-first. The system prompt, the first user task and the most recent
    groups are never elided and never dropped.
    --context-budget <tokens>  Estimated-token ceiling per request (default 48000)
    --keep-recent <n>          Most recent groups kept verbatim (default 6)
    Environment:               ZOO_CONTEXT_BUDGET_TOKENS / ZOO_CONTEXT_KEEP_GROUPS

    Token counts are ESTIMATES (chars/4), not exact counts. When a step prunes,
    one compact "[context] pruned: <before> -> <after> est. tokens (…)" line is
    written to stderr, and --json includes the last applied stats under
    "context" (null when nothing was pruned).

  Usage tracking (agent / chat / run):
    Token usage from each real run is appended to .zoo/usage.jsonl (gitignored).
    Recording is skipped when a run reports zero tokens (e.g. --mock) and when
    ZOO_NO_USAGE=1 is set. Cost is an ESTIMATE from a configurable pricing table
    (.zoo/pricing.json), never billing. The usage command is read-only.

  Execution policy for run_command (agent / chat / run):
    --exec-policy <deny|allowlist|ask|allow>
                deny       refuse every command
                allowlist  allow only allowlisted executables (CLI default)
                ask        prompt for approval before each command (chat only)
                allow      permit everything except the destructive denylist
    --allow-exec   Shorthand for --exec-policy allow
    --no-exec      Shorthand for --exec-policy deny — run_command refuses to spawn
    Environment:   ZOO_EXEC_POLICY=<deny|allowlist|ask|allow> is used when no flag
                   is given. The CLI default is "allowlist"; the library default
                   (createCoreTools() with no arguments) is "allow".

  improve — self-modification (WARNING: edits this repository!):
    \`zoocode improve "<goal>"\` edits THIS repository's own source. It has no
    "--mock" mode: a REAL API key is required. The loop refuses to run on a dirty
    working tree, then (by default) creates and checks out a fresh
    zoo/improve-<timestamp> branch so nothing lands on your current branch. It
    ALWAYS forces the strict \`allowlist\` exec policy — --exec-policy, --allow-exec
    and ZOO_EXEC_POLICY are ignored here, and writes are confined to the repo root
    (.env*, .git/, node_modules/, .claude/ and .zoo/usage.jsonl are refused). After
    the agent stops it runs the verify command as a MANDATORY gate: a red gate means
    failure no matter what the agent reported. Nothing is committed unless --commit
    is passed — the change otherwise stays on the branch, awaiting human review.

    --max-steps N        Agent step budget (default ${DEFAULT_IMPROVE_MAX_STEPS})
    --verify-cmd "<cmd>" Gate to run after the agent stops (default "${DEFAULT_VERIFY_COMMAND}")
    --commit             Stage and commit after a GREEN verify (default: do not commit)
    --dry-run            Preflight only: no branch, no agent, no writes
    --no-branch          Skip branch creation (work lands on the current branch)

  CLI default policy: ${describePolicy(createExecPolicy({ mode: CLI_DEFAULT_EXEC_MODE }))}
`

async function main(): Promise<number> {
  // Opt-in `.env` loading: keeps `loadConfig()` a pure env reader while letting
  // the CLI pick up a gitignored ZooCode/.env without restarting VS Code.
  loadDotenv()

  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }

  switch (command) {
    case 'tools':
      return cmdTools(rest)
    case 'agent':
      return await cmdAgent(rest)
    case 'chat':
      return await cmdChat(rest)
    case 'run':
      return await cmdRun(rest)
    case 'doctor':
      return cmdDoctor(rest)
    case 'analyze':
      return cmdAnalyze(rest)
    case 'search':
      return cmdSearch(rest)
    case 'usage':
      return cmdUsage(rest)
    case 'improve':
      return await cmdImprove(rest)
    case 'commit':
      return cmdPassthrough('scripts/commit.ts', rest)
    case 'scaffold':
      return cmdPassthrough('scripts/scaffold.ts', rest)
    default:
      logger.error(`Unknown command: ${command}`)
      console.log(USAGE)
      return 1
  }
}

try {
  process.exitCode = await main()
} catch (err) {
  logger.error(errorMessage(err))
  process.exitCode = 1
}
