import { describe, it, expect } from 'vitest'
import {
  createExecPolicy,
  defaultAllowlist,
  defaultDenyPatterns,
  describePolicy,
  evaluateCommand,
  executableName,
  executablesOf,
  execPolicyFromEnv,
  EXEC_POLICY_MODES,
  splitSegments,
  type ExecPolicy,
  type ExecPolicyMode,
} from '../lib/policy.js'

const CTX = { cwd: 'C:\\work', tool: 'run_command' }

/** A policy in `mode` that would approve anything, so only the mode decides. */
function policyFor(mode: ExecPolicyMode): ExecPolicy {
  return createExecPolicy({ mode, approve: () => true })
}

describe('createExecPolicy / defaults', () => {
  it('defaults to the permissive library behavior', () => {
    const policy = createExecPolicy()
    expect(policy.mode).toBe('allow')
    expect(policy.allowlist).toEqual(defaultAllowlist())
    expect(policy.denyPatterns.map((entry) => entry.label)).toEqual(
      defaultDenyPatterns().map((entry) => entry.label),
    )
  })

  it('preserves every historical denylist label verbatim', () => {
    const labels = createExecPolicy().denyPatterns.map((entry) => entry.label)
    expect(labels).toEqual([
      'rm -rf /',
      'mkfs',
      'format <drive>',
      'Remove-Item -Recurse -Force',
      'rmdir /s',
      'del /f /s /q',
      'dd if=',
      'fork bomb',
      'shutdown',
      'diskpart',
    ])
  })

  it('honors overrides and does not share mutable defaults', () => {
    const custom = createExecPolicy({ mode: 'allowlist', allowlist: ['node'], denyPatterns: [] })
    expect(custom.mode).toBe('allowlist')
    expect(custom.allowlist).toEqual(['node'])
    expect(custom.denyPatterns).toEqual([])

    custom.allowlist.push('curl')
    expect(createExecPolicy().allowlist).not.toContain('curl')
  })

  it('exposes the four modes and a focused dev allowlist', () => {
    expect(EXEC_POLICY_MODES).toEqual(['deny', 'allowlist', 'ask', 'allow'])
    const allowlist = defaultAllowlist()
    expect(allowlist).toContain('node')
    expect(allowlist).toContain('git')
    // Tight on purpose: general-purpose network/system tools stay out.
    expect(allowlist).not.toContain('curl')
    expect(allowlist).not.toContain('bash')
    expect(allowlist).not.toContain('powershell')
  })
})

describe('deny patterns are checked first, in every mode', () => {
  const destructive = [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'rm -r -f /',
    'mkfs.ext4 /dev/sda',
    'format D:',
    'Remove-Item -Recurse -Force C:\\',
    'rmdir /s /q C:\\temp',
    'del /f /s /q C:\\*',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
    'shutdown /s /t 0',
    'diskpart',
  ]

  it('refuses each pattern in all four modes', async () => {
    for (const mode of EXEC_POLICY_MODES) {
      for (const command of destructive) {
        const decision = await evaluateCommand(command, policyFor(mode), CTX)
        expect(decision.allowed, `${mode}: ${command}`).toBe(false)
        expect(decision.reason, `${mode}: ${command}`).toBe('denied-pattern')
        expect(decision.detail, `${mode}: ${command}`).toMatch(/^matched /)
      }
    }
  })

  it('renders the historical refusal detail', async () => {
    const decision = await evaluateCommand('rm -rf /', policyFor('allow'), CTX)
    expect(decision.detail).toBe('matched rm -rf /')
  })
})

describe('mode behavior', () => {
  it('allow permits anything the denylist did not catch', async () => {
    const decision = await evaluateCommand('curl https://example.com', policyFor('allow'), CTX)
    expect(decision).toEqual({ allowed: true, mode: 'allow', reason: 'allowed' })
  })

  it('deny refuses everything', async () => {
    const decision = await evaluateCommand('node --version', policyFor('deny'), CTX)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('denied-mode')
    expect(decision.detail).toContain('deny')
  })

  it('allowlist permits allowlisted executables only', async () => {
    const policy = createExecPolicy({ mode: 'allowlist' })

    const ok = await evaluateCommand('node --version', policy, CTX)
    expect(ok.allowed).toBe(true)
    expect(ok.reason).toBe('allowed')

    const refused = await evaluateCommand('curl https://example.com', policy, CTX)
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toBe('denied-not-allowlisted')
    expect(refused.detail).toBe('"curl" is not in the allowlist')
  })

  it('ask consults the approver', async () => {
    const approved = await evaluateCommand(
      'node --version',
      createExecPolicy({ mode: 'ask', approve: () => true }),
      CTX,
    )
    expect(approved.allowed).toBe(true)

    const rejected = await evaluateCommand(
      'node --version',
      createExecPolicy({ mode: 'ask', approve: () => false }),
      CTX,
    )
    expect(rejected.allowed).toBe(false)
    expect(rejected.reason).toBe('denied-by-approver')
  })

  it('ask supports an async approver and passes the request through', async () => {
    const seen: string[] = []
    const policy = createExecPolicy({
      mode: 'ask',
      approve: async (req) => {
        seen.push(`${req.tool}|${req.cwd}|${req.command}`)
        return true
      },
    })
    const decision = await evaluateCommand('git status', policy, CTX)
    expect(decision.allowed).toBe(true)
    expect(seen).toEqual(['run_command|C:\\work|git status'])
  })

  it('ask with no approver fails closed', async () => {
    const decision = await evaluateCommand('node --version', createExecPolicy({ mode: 'ask' }), CTX)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('denied-no-approver')
    expect(decision.detail).toContain('no approver')
  })

  it('an approver that throws fails closed rather than propagating', async () => {
    const policy = createExecPolicy({
      mode: 'ask',
      approve: () => {
        throw new Error('prompt exploded')
      },
    })
    const decision = await evaluateCommand('node --version', policy, CTX)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('denied-by-approver')
    expect(decision.detail).toContain('prompt exploded')
  })
})

describe('command segmentation', () => {
  it('splits every shell chain operator and newlines', () => {
    expect(splitSegments('a && b || c ; d | e').segments).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitSegments('a\nb\r\nc').segments).toEqual(['a', 'b', 'c'])
    expect(splitSegments('sleep 1 & echo done').segments).toEqual(['sleep 1', 'echo done'])
  })

  it('keeps quoted separators inside one segment', () => {
    expect(splitSegments('echo "a && b"').segments).toEqual(['echo "a && b"'])
    expect(splitSegments("node -e 'x ; y'").segments).toEqual(["node -e 'x ; y'"])
  })

  it('does not split redirections', () => {
    expect(splitSegments('node x.js 2>&1').segments).toEqual(['node x.js 2>&1'])
    expect(splitSegments('node a.js &> out.txt').segments).toEqual(['node a.js &> out.txt'])
    expect(splitSegments('echo hi > out.txt').segments).toEqual(['echo hi > out.txt'])
  })

  it('reports an unbalanced quote instead of guessing', () => {
    const parsed = splitSegments('node x.js "unterminated')
    expect(parsed.error).toContain('unmatched double quote')
    expect(splitSegments("echo 'oops").error).toContain('unmatched single quote')
  })

  it('refuses an unparseable command in allowlist mode', async () => {
    const decision = await evaluateCommand(
      'node x.js "unterminated',
      createExecPolicy({ mode: 'allowlist' }),
      CTX,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('denied-not-allowlisted')
    expect(decision.detail).toContain('cannot parse command')
  })
})

describe('a chain is only as safe as its weakest link', () => {
  it('refuses `node --version && rm -rf /`', async () => {
    const decision = await evaluateCommand(
      'node --version && rm -rf /',
      createExecPolicy({ mode: 'allowlist' }),
      CTX,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.detail).toBe('matched rm -rf /')
  })

  it('refuses a chain whose second executable is not allowlisted', async () => {
    const decision = await evaluateCommand(
      'node --version && curl https://example.com',
      createExecPolicy({ mode: 'allowlist' }),
      CTX,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('denied-not-allowlisted')
    expect(decision.detail).toContain('curl')
  })

  it('refuses a piped non-allowlisted executable', async () => {
    const decision = await evaluateCommand(
      'cat notes.txt | tee out.txt',
      createExecPolicy({ mode: 'allowlist' }),
      CTX,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.detail).toContain('tee')
  })

  it('permits a chain where every link is allowlisted', async () => {
    const decision = await evaluateCommand(
      'node --version && git status',
      createExecPolicy({ mode: 'allowlist' }),
      CTX,
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('executable extraction', () => {
  it('strips quotes, directories and Windows executable suffixes', () => {
    expect(executableName('node')).toBe('node')
    expect(executableName("'git'")).toBe('git')
    expect(executableName('"C:\\Program Files\\nodejs\\node.exe"')).toBe('node')
    expect(executableName('/usr/bin/node')).toBe('node')
    expect(executableName('..\\bin\\tsx.cmd')).toBe('tsx')
    expect(executableName('NODE.exe')).toBe('node')
  })

  it('reads the first token, skipping env assignments, and unwraps package runners', () => {
    expect(executablesOf('node --version')).toEqual(['node'])
    expect(executablesOf('NODE_ENV=production node server.js')).toEqual(['node'])
    expect(executablesOf('npx tsx script.ts')).toEqual(['npx', 'tsx'])
    expect(executablesOf('npx --yes cowsay hi')).toEqual(['npx', 'cowsay'])
    expect(executablesOf('pnpm dlx cowsay')).toEqual(['pnpm', 'cowsay'])
    expect(executablesOf('yarn dlx cowsay')).toEqual(['yarn', 'cowsay'])
    expect(executablesOf('   ')).toEqual([])
  })
})

describe('execPolicyFromEnv', () => {
  it('reads each valid mode', () => {
    for (const mode of EXEC_POLICY_MODES) {
      expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: mode })).toBe(mode)
    }
  })

  it('normalizes case and whitespace', () => {
    expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: '  AllowList ' })).toBe('allowlist')
  })

  it('falls back to the backward-compatible "allow" for unknown/empty/unset values', () => {
    expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: 'yolo' })).toBe('allow')
    expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: '' })).toBe('allow')
    expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: '   ' })).toBe('allow')
    expect(execPolicyFromEnv({})).toBe('allow')
    expect(execPolicyFromEnv({ ZOO_EXEC_POLICY: undefined })).toBe('allow')
  })

  it('never throws, even on a malformed environment', () => {
    expect(
      execPolicyFromEnv(null as unknown as Record<string, string | undefined>),
    ).toBe('allow')
  })
})

describe('describePolicy', () => {
  it('summarizes every mode on one line', () => {
    expect(describePolicy(createExecPolicy({ mode: 'deny' }))).toContain('exec-policy=deny')
    expect(describePolicy(createExecPolicy({ mode: 'allow' }))).toContain('exec-policy=allow')
    expect(describePolicy(createExecPolicy({ mode: 'allowlist' }))).toContain(
      'exec-policy=allowlist',
    )
    expect(describePolicy(createExecPolicy({ mode: 'allowlist' }))).toContain('node')
    expect(describePolicy(createExecPolicy({ mode: 'ask' }))).toContain('exec-policy=ask')
  })

  it('distinguishes an ask policy that has no approver', () => {
    expect(describePolicy(createExecPolicy({ mode: 'ask' }))).toContain('no approver configured')
    expect(describePolicy(createExecPolicy({ mode: 'ask', approve: () => true }))).not.toContain(
      'no approver configured',
    )
  })

  it('never returns an empty string', () => {
    for (const mode of EXEC_POLICY_MODES) {
      expect(describePolicy(createExecPolicy({ mode })).length).toBeGreaterThan(0)
    }
  })
})

describe('evaluateCommand is total (never throws)', () => {
  it('resolves rather than rejecting for a malformed policy', async () => {
    const decision = await evaluateCommand('node --version', null as unknown as ExecPolicy, CTX)
    expect(decision.allowed).toBe(true)
    expect(decision.mode).toBe('allow')
  })
})
