/**
 * Tool registry + core built-in tools for the homegrown agent harness.
 *
 * Implements the `ToolDef` contract from `lib/types.ts` and the four registry
 * entry points the harness and CLI depend on:
 *
 *   createCoreTools()  — every built-in tool (optionally policy-gated)
 *   getTool()          — lookup by name
 *   executeTool()      — run a tool, NEVER throws (errors become ToolResults)
 *   toolSummaries()    — compact { name, description } list for prompts
 *
 * Handlers resolve relative paths against `ctx.cwd` so the agent operates in
 * the working directory it was given, not the process cwd.
 */

import { exec } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolContext, ToolDef, ToolResult } from './types.js'
import { readFile as readTextFile, writeFile as writeTextFile } from './files.js'
import { searchProjects, type SearchOptions } from './search.js'
import { runDoctor } from './doctor.js'
import { addProjectNote, addProjectTodo, collectContext } from './context.js'
import { createExecPolicy, evaluateCommand, type ExecPolicy } from './policy.js'

/** Sane caps so a single tool call cannot blow the model's context window. */
const MAX_READ_CHARS = 40_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_LIST_ENTRIES = 500
const DEFAULT_TIMEOUT_MS = 30_000

/** Directories never worth listing for an agent. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.zoo', 'dist', '__pycache__'])

/*
 * The `run_command` denylist now lives in [`lib/policy.ts`](./policy.ts)
 * (`defaultDenyPatterns()`), together with the mode logic that consumes it.
 * `createCoreTools()` defaults to `createExecPolicy({ mode: 'allow' })`, which
 * reproduces the historical behaviour exactly: deny patterns first, then run.
 */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Stringify an arbitrary value into text safe to send back to the model. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** Truncate long text, appending a marker the model can understand. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated]`
}

/** Resolve `input` against `cwd` when it is not already absolute. */
function resolvePath(input: string, cwd: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input)
}

/** Read a required string argument, or undefined when absent / wrong type. */
function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize a path to forward slashes for stable, portable display. */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function fail(error: string): ToolResult {
  return { ok: false, error, content: error }
}

function combineOutput(stdout: string | Buffer, stderr: string | Buffer): string {
  const out = String(stdout ?? '').trimEnd()
  const errOut = String(stderr ?? '').trimEnd()
  return [out, errOut].filter((part) => part.length > 0).join('\n')
}

/**
 * Run a shell command, resolving (never rejecting) with a ToolResult. Non-zero
 * exit codes still include the captured output so the model can react.
 */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolvePromise) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
      (err, stdout, stderr) => {
        const output = combineOutput(stdout, stderr)
        if (!err) {
          resolvePromise({ ok: true, content: truncate(output || '(no output)', MAX_OUTPUT_CHARS) })
          return
        }
        const code = (err as { code?: unknown }).code
        if (typeof code === 'number') {
          resolvePromise({
            ok: false,
            error: `exit code ${code}`,
            content: truncate(output || `exit code ${code}`, MAX_OUTPUT_CHARS),
          })
          return
        }
        const message = errorMessage(err)
        resolvePromise({
          ok: false,
          error: message,
          content: truncate(output ? `${output}\n${message}` : message, MAX_OUTPUT_CHARS),
        })
      },
    )
  })
}

function readFileTool(): ToolDef {
  return {
    name: 'read_file',
    description:
      'Read a UTF-8 text file and return its contents. Relative paths resolve against the working directory. Large files are truncated.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute).' },
      },
      required: ['path'],
    },
    handler: async (args, ctx) => {
      const path = stringArg(args, 'path')
      if (!path) return fail('read_file requires a "path" string')
      const full = resolvePath(path, ctx.cwd)
      try {
        return { ok: true, content: truncate(readTextFile(full), MAX_READ_CHARS) }
      } catch (err) {
        return fail(`Failed to read ${path}: ${errorMessage(err)}`)
      }
    },
  }
}

function writeFileTool(): ToolDef {
  return {
    name: 'write_file',
    description:
      'Write UTF-8 text to a file, creating any missing parent directories. Overwrites the file if it already exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to write (relative or absolute).' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx) => {
      const path = stringArg(args, 'path')
      if (!path) return fail('write_file requires a "path" string')
      if (typeof args.content !== 'string') return fail('write_file requires a "content" string')
      const full = resolvePath(path, ctx.cwd)
      try {
        writeTextFile(full, args.content)
        const bytes = Buffer.byteLength(args.content, 'utf-8')
        return { ok: true, content: `Wrote ${bytes} bytes to ${path}` }
      } catch (err) {
        return fail(`Failed to write ${path}: ${errorMessage(err)}`)
      }
    },
  }
}

/**
 * Exact-string edit — the tool this harness was missing.
 *
 * Without it the only way to change one line was `write_file`, i.e. regenerate
 * the ENTIRE file. That is how a 900-line file came back truncated and lost the
 * tail of a switch statement, and how an oversized response killed a run with
 * "response body was not valid JSON". A search/replace block keeps the model's
 * output proportional to the size of the change, which is the actual fix.
 *
 * Refusal semantics matter as much as the happy path:
 *   - no match      → refuse with guidance (never silently write nothing)
 *   - several matches → refuse as ambiguous unless `all` is set, because
 *     silently editing the first of many is how the wrong site gets changed
 *   - CRLF files    → say so explicitly, since a search copied from a model
 *     that thinks in LF will otherwise never match on Windows
 */
function editFileTool(): ToolDef {
  return {
    name: 'edit_file',
    description:
      'Edit an existing file by replacing one exact block of text. PREFER THIS OVER write_file for any change to a file that already exists: it only sends the changed part, so the rest of the file cannot be truncated. The "search" text must match the file byte-for-byte, indentation included. Refuses if the text is not found, or if it appears more than once unless "all" is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit (relative or absolute).' },
        search: {
          type: 'string',
          description:
            'Exact text to find, copied verbatim from the file including indentation and line breaks.',
        },
        replace: {
          type: 'string',
          description: 'Text to replace it with. Use an empty string to delete the matched text.',
        },
        all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring the match to be unique.',
        },
      },
      required: ['path', 'search', 'replace'],
    },
    handler: async (args, ctx) => {
      const path = stringArg(args, 'path')
      if (!path) return fail('edit_file requires a "path" string')
      if (typeof args.search !== 'string' || args.search.length === 0) {
        return fail('edit_file requires a non-empty "search" string')
      }
      if (typeof args.replace !== 'string') return fail('edit_file requires a "replace" string')
      const full = resolvePath(path, ctx.cwd)

      if (!existsSync(full)) {
        return fail(`File does not exist: ${path}. Use write_file to create a new file.`)
      }

      let before: string
      try {
        before = readTextFile(full)
      } catch (err) {
        return fail(`Failed to read ${path}: ${errorMessage(err)}`)
      }

      const search = args.search
      // split/join rather than String.replace: the replacement text may contain
      // "$&"-style sequences, which replace() would treat as backreferences.
      const occurrences = before.split(search).length - 1

      if (occurrences === 0) {
        if (before.includes('\r\n') && !search.includes('\r\n')) {
          return fail(
            `The "search" text was not found in ${path}. This file uses CRLF line endings, so the search text must contain them too — read the file and copy the exact bytes.`,
          )
        }
        return fail(
          `The "search" text was not found in ${path}. Read the file and copy the exact text, indentation and line breaks included.`,
        )
      }

      const replaceAll = args.all === true
      if (occurrences > 1 && !replaceAll) {
        return fail(
          `The "search" text appears ${occurrences} times in ${path}, so the edit is ambiguous. Include more surrounding text to make it unique, or pass "all": true to replace every occurrence.`,
        )
      }

      const after = before.split(search).join(args.replace)
      try {
        writeTextFile(full, after)
      } catch (err) {
        return fail(`Failed to write ${path}: ${errorMessage(err)}`)
      }

      const replaced = replaceAll ? occurrences : 1
      return {
        ok: true,
        content: `Edited ${path}: replaced ${replaced} occurrence${replaced === 1 ? '' : 's'}.`,
      }
    },
  }
}

function listFilesTool(): ToolDef {
  return {
    name: 'list_files',
    description:
      'List files under a directory, skipping node_modules, .git, .zoo, dist and __pycache__. Set recursive to walk subdirectories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (default: the working directory).' },
        recursive: { type: 'boolean', description: 'Walk subdirectories (default false).' },
      },
    },
    handler: async (args, ctx) => {
      const base = resolvePath(stringArg(args, 'path') ?? '.', ctx.cwd)
      const recursive = args.recursive === true

      if (!existsSync(base)) return fail(`Path does not exist: ${base}`)
      let baseStat
      try {
        baseStat = statSync(base)
      } catch (err) {
        return fail(`Cannot stat ${base}: ${errorMessage(err)}`)
      }

      if (baseStat.isFile()) {
        return { ok: true, content: toPosix(relative(resolve(ctx.cwd, '.'), base)) || base }
      }
      if (!baseStat.isDirectory()) return fail(`Not a directory: ${base}`)

      const entries: string[] = []
      let truncated = false

      const walk = (dir: string): void => {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        let dirents
        try {
          dirents = readdirSync(dir, { withFileTypes: true })
        } catch {
          return // unreadable directory — skip
        }
        for (const entry of dirents) {
          if (entries.length >= MAX_LIST_ENTRIES) {
            truncated = true
            return
          }
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || !recursive) continue
            walk(join(dir, entry.name))
          } else if (entry.isFile()) {
            entries.push(toPosix(relative(base, join(dir, entry.name))))
          }
        }
      }

      walk(base)
      entries.sort()

      if (entries.length === 0) {
        return { ok: true, content: `No files found under ${base}` }
      }
      const body = entries.join('\n')
      return {
        ok: true,
        content: truncated ? `${body}\n[truncated at ${MAX_LIST_ENTRIES} entries]` : body,
      }
    },
  }
}

function searchFilesTool(): ToolDef {
  return {
    name: 'search_files',
    description:
      'Regex-search files across projects and return `project/file:line: text` hits. Optionally restrict by file extension, hit count, or a single project.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to match.' },
        ext: { type: 'string', description: 'Only search files with this extension (e.g. ".ts").' },
        max: { type: 'number', description: 'Maximum hits to return per project.' },
        project: { type: 'string', description: 'Restrict the search to a single project (name or absolute path).' },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      const pattern = stringArg(args, 'pattern')
      if (!pattern) return fail('search_files requires a "pattern" string')

      const options: SearchOptions = {}
      if (typeof args.ext === 'string' && args.ext) options.ext = args.ext
      if (typeof args.max === 'number' && args.max > 0) options.max = args.max
      if (typeof args.project === 'string' && args.project) options.project = args.project

      const result = searchProjects(pattern, options)
      if (!result.ok || !result.data) {
        return fail(result.error ?? 'search failed')
      }

      const hits = result.data.hits
      if (hits.length === 0) {
        return { ok: true, content: `No matches for /${pattern}/` }
      }
      const lines = hits.map((hit) => `${hit.project}/${toPosix(hit.file)}:${hit.line}: ${hit.text}`)
      return { ok: true, content: truncate(lines.join('\n'), MAX_OUTPUT_CHARS) }
    },
  }
}

function runCommandTool(allowExec: boolean, policy: ExecPolicy): ToolDef {
  return {
    name: 'run_command',
    description:
      'Run a shell command in the working directory and return its combined stdout/stderr. Every command is judged by the active execution policy (mode + destructive-pattern denylist). Non-zero exits are reported with their output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory (default: the session working directory).' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000).' },
      },
      required: ['command'],
    },
    handler: async (args, ctx) => {
      const command = stringArg(args, 'command')
      if (!command) return fail('run_command requires a "command" string')

      // Execution opt-in gate: refuse before touching the shell.
      if (!allowExec) {
        return fail('Command execution is disabled (allowExec=false)')
      }

      const cwd =
        typeof args.cwd === 'string' && args.cwd ? resolvePath(args.cwd, ctx.cwd) : ctx.cwd

      // Policy gate (deny patterns always apply, then the mode). `content` is
      // the command itself, so the model always sees what was refused.
      const decision = await evaluateCommand(command, policy, { cwd, tool: 'run_command' })
      if (!decision.allowed) {
        return {
          ok: false,
          error: `Command refused by policy: ${decision.detail ?? decision.reason}`,
          content: command,
        }
      }

      const timeoutMs =
        typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS

      return runShell(command, cwd, timeoutMs, ctx.signal)
    },
  }
}

function zooDoctorTool(): ToolDef {
  return {
    name: 'zoo_doctor',
    description:
      'Run the environment doctor and return one `name: status` line per check plus ok/warn/fail counts.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const result = runDoctor()
      if (!result.ok || !result.data) return fail(result.error ?? 'doctor failed')
      const report = result.data
      const lines = report.checks.map(
        (check) => `${check.name}: ${check.status}${check.detail ? ` — ${check.detail}` : ''}`,
      )
      lines.push(
        `summary: ok=${report.summary.ok} warn=${report.summary.warn} fail=${report.summary.fail} (${report.healthy ? 'healthy' : 'unhealthy'})`,
      )
      return { ok: true, content: lines.join('\n') }
    },
  }
}

function zooNotesTool(): ToolDef {
  return {
    name: 'zoo_notes',
    description:
      "Persistent cross-session memory. Pass `note` to append a note and/or `todo` to append a todo for a project; omit both to read back the project's recorded context.",
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name to record against.' },
        note: { type: 'string', description: 'Note text to append.' },
        todo: { type: 'string', description: 'Todo text to append.' },
      },
      required: ['project'],
    },
    handler: async (args, ctx) => {
      const project = stringArg(args, 'project')
      if (!project) return fail('zoo_notes requires a "project" string')

      const note = typeof args.note === 'string' && args.note ? args.note : undefined
      const todo = typeof args.todo === 'string' && args.todo ? args.todo : undefined

      if (!note && !todo) {
        const snapshot = collectContext([project], ctx.cwd)
        if (!snapshot.ok || !snapshot.data) return fail(snapshot.error ?? 'failed to load context')
        return { ok: true, content: snapshot.data.summary }
      }

      const written: string[] = []
      if (note) {
        const res = addProjectNote(project, note, ctx.cwd)
        if (!res.ok) return fail(res.error ?? 'failed to add note')
        written.push('note')
      }
      if (todo) {
        const res = addProjectTodo(project, todo, ctx.cwd)
        if (!res.ok) return fail(res.error ?? 'failed to add todo')
        written.push('todo')
      }
      return { ok: true, content: `Recorded ${written.join(' and ')} for ${project}` }
    },
  }
}

function finishTool(): ToolDef {
  return {
    name: 'finish',
    description:
      'TERMINAL TOOL. Call this when the task is fully complete: it is a no-op that the harness treats as an explicit "task complete" signal. Provide a concise summary of what was accomplished. Do not call any tools after finish.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise summary of the completed work.' },
      },
      required: ['summary'],
    },
    handler: async (args) => {
      const summary = typeof args.summary === 'string' ? args.summary : ''
      return { ok: true, content: summary }
    },
  }
}

/** Options for {@link createCoreTools}. */
export interface CoreToolOptions {
  /**
   * When `false`, `run_command` refuses to spawn any process. Defaults to
   * `true`, which preserves the historical behaviour for existing callers.
   */
  allowExec?: boolean
  /**
   * Execution policy consulted by `run_command`. Defaults to
   * `createExecPolicy({ mode: 'allow' })` — the historical behavior, i.e. the
   * destructive-pattern denylist only. Supply a stricter policy (see
   * [`lib/policy.ts`](./policy.ts)) to gate execution; the CLI defaults to
   * `allowlist`.
   */
  policy?: ExecPolicy
}

/**
 * All built-in tools. Handlers are pure with respect to the process cwd — they
 * resolve relative paths against `ctx.cwd`. Pass `{ allowExec: false }` to wire
 * a session in which shell execution is disabled, and/or `{ policy }` to put a
 * mode-based policy in front of `run_command`.
 */
export function createCoreTools(options: CoreToolOptions = {}): ToolDef[] {
  const allowExec = options.allowExec ?? true
  const policy = options.policy ?? createExecPolicy({ mode: 'allow' })
  return [
    readFileTool(),
    writeFileTool(),
    editFileTool(),
    listFilesTool(),
    searchFilesTool(),
    runCommandTool(allowExec, policy),
    zooDoctorTool(),
    zooNotesTool(),
    finishTool(),
  ]
}

/** Find a tool by exact name. */
export function getTool(tools: ToolDef[], name: string): ToolDef | undefined {
  return tools.find((tool) => tool.name === name)
}

/**
 * Execute a tool by name. NEVER throws:
 *  - unknown tool          → { ok: false, error: 'Unknown tool: <name>' }
 *  - handler threw         → { ok: false, error, content }
 *  - invalid handler value → { ok: false, error: 'Tool <name> returned an invalid result' }
 * `content` is always a string suitable to send back to the model.
 */
export async function executeTool(
  tools: ToolDef[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = getTool(tools, name)
  if (!tool) {
    return fail(`Unknown tool: ${name}`)
  }

  let raw: unknown
  try {
    raw = await tool.handler(args ?? {}, ctx)
  } catch (err) {
    return fail(errorMessage(err))
  }

  if (typeof raw !== 'object' || raw === null) {
    return fail(`Tool ${name} returned an invalid result`)
  }

  const candidate = raw as { ok?: unknown; content?: unknown; error?: unknown }
  if (typeof candidate.ok !== 'boolean') {
    return fail(`Tool ${name} returned an invalid result`)
  }

  const result: ToolResult = { ok: candidate.ok, content: stringify(candidate.content) }
  if (typeof candidate.error === 'string' && candidate.error.length > 0) {
    result.error = candidate.error
  }
  return result
}

/** Compact name/description list suitable for a system prompt. */
export function toolSummaries(tools: ToolDef[]): { name: string; description: string }[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description }))
}
