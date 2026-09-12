import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreTools, getTool, executeTool, toolSummaries } from '../lib/tools.js'
import { createExecPolicy } from '../lib/policy.js'
import type { ToolContext, ToolDef, ToolResult } from '../lib/types.js'

const EXPECTED_TOOLS = [
  'finish',
  'list_files',
  'read_file',
  'run_command',
  'search_files',
  'write_file',
  'zoo_doctor',
  'zoo_notes',
].sort()

let dir: string
let ctx: ToolContext
let tools: ToolDef[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zoocode-tools-'))
  ctx = { cwd: dir }
  tools = createCoreTools()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createCoreTools', () => {
  it('returns the 8 built-in tools', () => {
    expect(tools).toHaveLength(8)
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS)
  })

  it('gives every tool an object parameter schema', () => {
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object')
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(typeof tool.handler).toBe('function')
    }
  })
})

describe('getTool', () => {
  it('finds a tool by name', () => {
    expect(getTool(tools, 'read_file')?.name).toBe('read_file')
  })

  it('returns undefined for an unknown tool', () => {
    expect(getTool(tools, 'not_a_tool')).toBeUndefined()
  })
})

describe('toolSummaries', () => {
  it('returns a name/description pair per tool', () => {
    const summaries = toolSummaries(tools)
    expect(summaries).toHaveLength(8)
    expect(summaries.every((entry) => entry.name.length > 0 && entry.description.length > 0)).toBe(true)
  })
})

describe('executeTool', () => {
  it('returns ok:false (no throw) for an unknown tool', async () => {
    const result = await executeTool(tools, 'not_a_tool', {}, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown tool')
    expect(typeof result.content).toBe('string')
  })

  it('catches a handler that throws', async () => {
    const boom: ToolDef = {
      name: 'boom',
      description: 'always throws',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('kaboom')
      },
    }
    const result = await executeTool([boom], 'boom', {}, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('kaboom')
    expect(typeof result.content).toBe('string')
  })

  it('normalizes a non-conforming handler return value', async () => {
    const bad: ToolDef = {
      name: 'bad',
      description: 'returns junk',
      parameters: { type: 'object', properties: {} },
      handler: async () => null as unknown as ToolResult,
    }
    const result = await executeTool([bad], 'bad', {}, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid result')
    expect(typeof result.content).toBe('string')
  })
})

describe('read_file / write_file', () => {
  it('round-trips content through write_file then read_file', async () => {
    const write = await executeTool(tools, 'write_file', { path: 'sub/hello.txt', content: 'hello world' }, ctx)
    expect(write.ok).toBe(true)
    expect(existsSync(join(dir, 'sub', 'hello.txt'))).toBe(true)

    const read = await executeTool(tools, 'read_file', { path: 'sub/hello.txt' }, ctx)
    expect(read.ok).toBe(true)
    expect(read.content).toBe('hello world')
  })

  it('reports a missing file as an error', async () => {
    const read = await executeTool(tools, 'read_file', { path: 'does-not-exist.txt' }, ctx)
    expect(read.ok).toBe(false)
    expect(read.error).toBeTruthy()
  })
})

describe('list_files', () => {
  it('lists files recursively but skips node_modules', async () => {
    await executeTool(tools, 'write_file', { path: 'node_modules/dep/index.js', content: 'dep' }, ctx)
    await executeTool(tools, 'write_file', { path: 'src/index.ts', content: 'src' }, ctx)

    const result = await executeTool(tools, 'list_files', { path: '.', recursive: true }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('src/index.ts')
    expect(result.content).not.toContain('node_modules')
  })
})

describe('search_files', () => {
  it('finds a planted string in a project', async () => {
    const projectDir = join(dir, 'proj')
    await executeTool(
      tools,
      'write_file',
      { path: 'proj/sample.ts', content: 'export const UNIQUE_MARKER_XZ_42 = 42\n' },
      ctx,
    )

    const result = await executeTool(tools, 'search_files', { pattern: 'UNIQUE_MARKER_XZ_42', project: projectDir }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('UNIQUE_MARKER_XZ_42')
    expect(result.content).toContain('sample.ts')
  })

  it('propagates a search error as ok:false', async () => {
    const result = await executeTool(tools, 'search_files', { pattern: 'x', project: join(dir, 'missing-project') }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('run_command', () => {
  it('runs `node --version` successfully', async () => {
    const result = await executeTool(tools, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('v')
  })

  it('returns ok:false with the output for a non-zero exit', async () => {
    const result = await executeTool(tools, 'run_command', { command: 'node --this-flag-does-not-exist' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exit code')
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('refuses a destructive pattern via the denylist', async () => {
    const result = await executeTool(tools, 'run_command', { command: 'rm -rf /' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Command refused by policy')
  })

  it('refuses the `rm -rf /*` bypass', async () => {
    const result = await executeTool(tools, 'run_command', { command: 'rm -rf /*' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Command refused by policy')
  })

  it('refuses recursive-force rm in either flag order, with and without a trailing space', async () => {
    for (const command of ['rm -rf /', 'rm -rf /*', 'rm -rf / ', 'rm -fr /', 'rm -r -f /']) {
      const result = await executeTool(tools, 'run_command', { command }, ctx)
      expect(result.ok, command).toBe(false)
      expect(result.error, command).toContain('Command refused by policy')
    }
  })

  it('refuses common Windows/PowerShell destructive patterns', async () => {
    const destructive = [
      'Remove-Item -Recurse -Force C:\\',
      'Remove-Item -Force -Recurse C:\\',
      'rmdir /s /q C:\\temp',
      'del /f /s /q C:\\*',
      'del /q /s /f C:\\*',
      'format D:',
      'diskpart',
      'shutdown /s /t 0',
      'dd if=/dev/zero of=/dev/sda',
      ':(){ :|:& };:',
    ]
    for (const command of destructive) {
      const result = await executeTool(tools, 'run_command', { command }, ctx)
      expect(result.ok, command).toBe(false)
      expect(result.error, command).toContain('Command refused by policy')
    }
  })
})

describe('createCoreTools({ allowExec })', () => {
  it('refuses to spawn commands when allowExec is false', async () => {
    const noExec = createCoreTools({ allowExec: false })
    const result = await executeTool(noExec, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('allowExec=false')
    expect(result.content).toContain('disabled')
  })

  it('still executes commands by default', async () => {
    const result = await executeTool(createCoreTools(), 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(true)
  })

  it('still exposes all 8 tools when exec is disabled', () => {
    expect(createCoreTools({ allowExec: false })).toHaveLength(8)
  })
})

describe('zoo_doctor', () => {
  it('returns a compact check summary', async () => {
    const result = await executeTool(tools, 'zoo_doctor', {}, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('node')
    expect(result.content).toContain('summary:')
  })
})

describe('zoo_notes', () => {
  it('writes a note and reads it back', async () => {
    const write = await executeTool(tools, 'zoo_notes', { project: 'demo', note: 'a memorable note' }, ctx)
    expect(write.ok).toBe(true)

    const statePath = join(dir, '.zoo', 'state.json')
    expect(existsSync(statePath)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      projects: Record<string, { notes: string[] }>
    }
    expect(state.projects.demo.notes).toContain('a memorable note')

    const read = await executeTool(tools, 'zoo_notes', { project: 'demo' }, ctx)
    expect(read.ok).toBe(true)
    expect(read.content).toContain('notes=1')
  })

  it('appends a todo', async () => {
    const write = await executeTool(tools, 'zoo_notes', { project: 'demo', todo: 'ship it' }, ctx)
    expect(write.ok).toBe(true)

    const read = await executeTool(tools, 'zoo_notes', { project: 'demo' }, ctx)
    expect(read.ok).toBe(true)
    expect(read.content).toContain('todos=1')
  })
})

describe('run_command with an execution policy', () => {
  it('runs an allowlisted executable in allowlist mode', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'allowlist' }) })
    const result = await executeTool(policed, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('v')
  })

  it('refuses a non-allowlisted executable and echoes the command', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'allowlist' }) })
    const command = 'curl https://example.com'
    const result = await executeTool(policed, 'run_command', { command }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Command refused by policy')
    expect(result.error).toContain('curl')
    expect(result.content).toBe(command)
  })

  it('refuses a chained command whose second link is not allowlisted', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'allowlist' }) })
    const result = await executeTool(
      policed,
      'run_command',
      { command: 'node --version && rm -rf /' },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Command refused by policy: matched rm -rf /')
  })

  it('still refuses deny patterns under the permissive policy', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'allow' }) })
    const result = await executeTool(policed, 'run_command', { command: 'rm -rf /' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Command refused by policy: matched rm -rf /')
  })

  it('refuses everything in deny mode', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'deny' }) })
    const result = await executeTool(policed, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Command refused by policy')
  })

  it('fails closed in ask mode when no approver is configured', async () => {
    const policed = createCoreTools({ policy: createExecPolicy({ mode: 'ask' }) })
    const result = await executeTool(policed, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Command refused by policy')
    expect(result.error).toContain('no approver')
  })

  it('runs the command when the ask approver approves', async () => {
    const policed = createCoreTools({
      policy: createExecPolicy({ mode: 'ask', approve: () => true }),
    })
    const result = await executeTool(policed, 'run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(true)
  })

  it('keeps the allowExec=false refusal ahead of the policy', async () => {
    const policed = createCoreTools({
      allowExec: false,
      policy: createExecPolicy({ mode: 'allowlist' }),
    })
    const result = await executeTool(policed, 'run_command', { command: 'rm -rf /' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Command execution is disabled (allowExec=false)')
  })

  it('still exposes all 8 tools with a policy attached', () => {
    expect(createCoreTools({ policy: createExecPolicy({ mode: 'deny' }) })).toHaveLength(8)
  })
})
