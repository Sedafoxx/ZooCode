/**
 * Parallel sub-agent runner for the homegrown harness.
 *
 * `runParallel` fans a list of `SubTask`s out over `runAgent` while enforcing a
 * concurrency ceiling. Each task gets its OWN transcript (built via
 * `createMessages`) and its OWN scoped tool list (`toolsForTask`), so sub-agents
 * never share conversation state even though they share one `LlmClient` and one
 * `ToolDef[]` pool.
 *
 * Guarantees:
 *  - results come back in the SAME ORDER as the input tasks
 *  - a throwing task is isolated: it becomes `{ ok: false, error }` and the rest
 *    of the batch still runs to completion
 *  - `runParallel` NEVER throws: any runner-level failure is reported as
 *    `{ ok: false, results, error }`
 *  - `ok` is true only when EVERY task succeeded
 */

import { createMessages, runAgent } from './harness.js'
import { DEFAULT_CONCURRENCY } from './config.js'
import type {
  AgentEvent,
  LlmClient,
  RunAgentOptions,
  RunAgentResult,
  SubTask,
  ToolDef,
} from './types.js'

// `lib/config.ts` is the single source of truth for this default. Re-export it
// so existing consumers of the sub-agent module keep working.
export { DEFAULT_CONCURRENCY }

/** Error text recorded for tasks that never got a worker slot before abort. */
const ABORT_ERROR = 'Aborted'

export interface RunParallelOptions {
  llm: LlmClient
  tools: ToolDef[]
  systemPrompt?: string
  maxSteps?: number
  cwd?: string
  concurrency?: number
  signal?: AbortSignal
  onTaskEvent?: (taskId: string, event: unknown) => void
}

export interface SubTaskResult {
  id: string
  ok: boolean
  final: string
  steps: number
  error?: string
  result: RunAgentResult
}

export interface RunParallelResult {
  ok: boolean
  results: SubTaskResult[]
  error?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Clamp the requested pool width into a sane integer.
 *
 * `undefined`/`NaN` fall back to the default; anything below 1 (including 0 and
 * negatives) is normalized to 1 so the pool always makes progress.
 */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY
  const floored = Math.floor(value)
  return floored < 1 ? 1 : floored
}

/** Minimal stand-in transcript for a task that never produced a real run. */
function syntheticResult(error: string): RunAgentResult {
  return { ok: false, messages: [], final: '', steps: 0, error }
}

function failureResult(id: string, error: string): SubTaskResult {
  return { id, ok: false, final: '', steps: 0, error, result: syntheticResult(error) }
}

/**
 * Filter the shared tool list down to the names a task declared.
 *
 * - `task.tools` omitted or empty → the full pool (copy, never the caller's array)
 * - `task.tools` provided         → only those names, preserving the request's
 *   order and duplicates; names with no matching tool are dropped
 */
export function toolsForTask(allTools: ToolDef[], task: SubTask): ToolDef[] {
  const requested = task.tools
  if (!requested || requested.length === 0) return [...allTools]

  const byName = new Map<string, ToolDef>()
  for (const tool of allTools) byName.set(tool.name, tool)

  const scoped: ToolDef[] = []
  for (const name of requested) {
    const tool = byName.get(name)
    if (tool) scoped.push(tool)
  }
  return scoped
}

/** Run a single task, converting any throw into an isolated failure result. */
async function runSubTask(task: SubTask, options: RunParallelOptions): Promise<SubTaskResult> {
  // Isolation: every task owns a fresh transcript; nothing is shared.
  const messages = createMessages(task.prompt, task.system ?? options.systemPrompt)

  const runOptions: RunAgentOptions = {
    llm: options.llm,
    tools: toolsForTask(options.tools, task),
    messages,
  }
  if (options.maxSteps !== undefined) runOptions.maxSteps = options.maxSteps
  if (options.cwd !== undefined) runOptions.cwd = options.cwd
  if (options.signal) runOptions.signal = options.signal

  const onTaskEvent = options.onTaskEvent
  if (onTaskEvent) {
    // Forward the sub-agent's event stream, tagged with this task's id.
    runOptions.onEvent = (event: AgentEvent): void => onTaskEvent(task.id, event)
  }

  try {
    const result = await runAgent(runOptions)
    const subTaskResult: SubTaskResult = {
      id: task.id,
      ok: result.ok,
      final: result.final,
      steps: result.steps,
      result,
    }
    if (result.error !== undefined) subTaskResult.error = result.error
    return subTaskResult
  } catch (err) {
    // Failure isolation: a rejecting runAgent must not sink the whole batch.
    return failureResult(task.id, errorMessage(err))
  }
}

/**
 * Run every task, at most `concurrency` at a time, and collect the results.
 *
 * Implementation is a classic worker pool: a fixed number of async workers pull
 * indices off a single shared cursor until the queue drains. Because each worker
 * takes its index synchronously before its first `await`, at most `concurrency`
 * tasks can ever be in flight.
 */
export function runParallel(
  tasks: SubTask[],
  options: RunParallelOptions,
): Promise<RunParallelResult> {
  // Empty input: resolve immediately, never touching the llm.
  if (tasks.length === 0) return Promise.resolve({ ok: true, results: [] })

  const slots: (SubTaskResult | undefined)[] = Array.from({ length: tasks.length })
  const concurrency = normalizeConcurrency(options.concurrency)
  const poolSize = Math.min(concurrency, tasks.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      // Abort check happens before claiming a slot: queued work never starts.
      if (options.signal?.aborted) return

      const index = cursor
      cursor += 1
      if (index >= tasks.length) return

      slots[index] = await runSubTask(tasks[index], options)
    }
  }

  return (async (): Promise<RunParallelResult> => {
    try {
      const workers: Promise<void>[] = []
      for (let i = 0; i < poolSize; i++) workers.push(worker())
      await Promise.all(workers)
    } catch (err) {
      // Unreachable in practice (workers swallow faults), but never escape.
      const results = finalize(tasks, slots)
      return { ok: false, results, error: errorMessage(err) }
    }

    const results = finalize(tasks, slots)
    return { ok: results.every((entry) => entry.ok), results }
  })()
}

/**
 * Turn the slot array into the ordered result list, filling slots that never ran
 * (aborted before a worker claimed them) with an `Aborted` failure.
 */
function finalize(
  tasks: SubTask[],
  slots: (SubTaskResult | undefined)[],
): SubTaskResult[] {
  return tasks.map((task, index) => slots[index] ?? failureResult(task.id, ABORT_ERROR))
}
