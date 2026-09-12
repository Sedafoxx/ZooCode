/**
 * Execution policy — the approval layer that sits between the model and the
 * shell.
 *
 * `run_command` is the one tool that hands arbitrary code execution to a
 * model. Before this module existed the only gate was a short regex denylist
 * inside [`lib/tools.ts`](./tools.ts). This module turns that gate into a real
 * policy engine with four modes, shell-aware command segmentation, and an
 * optional interactive approver.
 *
 * Layering: this is L1 (beside `lib/tools.ts`). It has **zero dependencies** —
 * no Node built-ins, no imports at all — so it can be reasoned about and tested
 * in isolation.
 *
 * ## Semantics (implemented precisely)
 *
 * 1. **Deny patterns are evaluated first, in EVERY mode** — including `allow`.
 *    A matched pattern always wins and renders as
 *    `Command refused by policy: matched <label>`.
 * 2. **`deny`** refuses everything.
 * 3. **`allowlist`** refuses unless the executable of EVERY command segment is
 *    allowlisted. A chain (`a && b`, `a | b`, `a ; b`, newlines) is only as
 *    safe as its weakest link, so every segment is checked.
 * 4. **`ask`** consults `approve`. With no approver it **fails closed**
 *    (`denied-no-approver`) — it never silently allows.
 * 5. **`allow`** permits everything the deny patterns did not catch.
 *
 * ## Known limits (deliberate, not accidental)
 *
 * This is a policy layer, **not a sandbox**. It reads a command string; it does
 * not model the shell. Command substitution (`$(...)`, backticks), here-docs,
 * `source`, and interpreter arguments (`node -e "…"`, `python -c "…"`) are not
 * resolved — the allowlist judges the executable it can see. Segmentation is
 * conservative about quoting: a line with an unbalanced quote is refused in
 * `allowlist` mode rather than guessed at.
 */

export type ExecPolicyMode = 'deny' | 'allowlist' | 'ask' | 'allow'

/** A single command awaiting an approval decision. */
export interface ApprovalRequest {
  command: string
  cwd: string
  tool: string
}

export interface ExecPolicy {
  mode: ExecPolicyMode
  /** Executable basenames permitted in `allowlist` mode (compared lowercase). */
  allowlist: string[]
  /** Always applied, in every mode, before any other check. */
  denyPatterns: { label: string; pattern: RegExp }[]
  /** Consulted only in `ask` mode. Absence means "fail closed". */
  approve?: (req: ApprovalRequest) => boolean | Promise<boolean>
}

export interface PolicyDecision {
  allowed: boolean
  mode: ExecPolicyMode
  /**
   * Machine-readable outcome: 'allowed' | 'denied-mode' | 'denied-pattern' |
   * 'denied-not-allowlisted' | 'denied-no-approver' | 'denied-by-approver'.
   */
  reason: string
  /**
   * Human-readable detail, e.g. `matched rm -rf /`. The refusal message is
   * rendered as `Command refused by policy: <detail>`.
   */
  detail?: string
}

/** Every valid mode, in documentation order. */
export const EXEC_POLICY_MODES: readonly ExecPolicyMode[] = ['deny', 'allowlist', 'ask', 'allow']

/**
 * The destructive patterns that are refused in **every** mode.
 *
 * These lived in `lib/tools.ts` before this module existed; they moved here
 * verbatim, **labels included**, so every rendered message
 * (`matched rm -rf /`) is byte-for-byte unchanged.
 *
 * This is deliberately short and documented — it is NOT a sandbox. It only
 * refuses a handful of obviously destructive patterns; anything else is passed
 * to the shell as-is, and a determined caller can always evade a string
 * denylist.
 */
export function defaultDenyPatterns(): { label: string; pattern: RegExp }[] {
  return [
    // POSIX recursive-force delete of the filesystem root. Requires BOTH an
    // `r` and an `f` flag (any order/combination) followed by a path that is
    // exactly `/` or `/*`: `rm -rf /`, `rm -rf /*`, `rm -fr /`, `rm -r -f /`.
    {
      pattern: /\brm\s+(?=[^;&|]*-[a-z]*r)(?=[^;&|]*-[a-z]*f)[^;&|]*?\/\*?(?=[\s;&|)]|$)/i,
      label: 'rm -rf /',
    },
    { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, label: 'mkfs' },
    { pattern: /\bformat\s+[a-z]:/i, label: 'format <drive>' },
    // Windows/PowerShell recursive-force delete (either flag order).
    {
      pattern: /\bRemove-Item\b(?=[^|;&]*-(?:Recurse|r)\b)(?=[^|;&]*-(?:Force|f)\b)/i,
      label: 'Remove-Item -Recurse -Force',
    },
    // Legacy shell deletions.
    { pattern: /\brmdir(?:\.exe)?\b[^|;&]*\/s\b/i, label: 'rmdir /s' },
    {
      pattern: /\b(?:del|erase)(?:\.exe)?\b(?=[^|;&]*\/f\b)(?=[^|;&]*\/s\b)(?=[^|;&]*\/q\b)/i,
      label: 'del /f /s /q',
    },
    { pattern: /\bdd\b[^|;&]*\bif=/i, label: 'dd if=' },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork bomb' },
    { pattern: /\bshutdown\b/i, label: 'shutdown' },
    { pattern: /\bdiskpart\b/i, label: 'diskpart' },
  ]
}

/**
 * The workshop dev allowlist used by `allowlist` mode.
 *
 * **Tradeoff:** this is intentionally *tight* — a focused set of the toolchain
 * this repo's agents actually drive (node/npm/npx/pnpm/yarn/tsx/tsc/vitest/
 * oxlint, the read-only-ish shell builtins agents lean on, git, python/pip, and
 * `pwsh`). Anything missing is refused, so the list is expected to grow as
 * legitimate workflows appear; that friction is the point. It is **not** a
 * general-purpose allowlist: `curl`, `wget`, `ssh`, `docker`, `powershell`
 * (the older Windows host), `cmd`, `bash`, and every other interpreter are
 * deliberately absent.
 */
export function defaultAllowlist(): string[] {
  return [
    // JS/TS toolchain — everything `npm run verify` and the CLI itself use.
    'node',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'tsx',
    'tsc',
    'vitest',
    'oxlint',
    // Read/parse-friendly shell builtins agents use constantly.
    'echo',
    'mkdir',
    'dir',
    'ls',
    'cat',
    'type',
    // Version control.
    'git',
    // Python toolchain.
    'python',
    'py',
    'pip',
    // The PowerShell host (the default shell on this workshop's Windows box).
    'pwsh',
  ]
}

function isMode(value: string): value is ExecPolicyMode {
  return (EXEC_POLICY_MODES as readonly string[]).includes(value)
}

/** Coerce an arbitrary value to a valid mode, falling back to `allow`. */
function normalizeMode(value: unknown): ExecPolicyMode {
  return typeof value === 'string' && isMode(value) ? value : 'allow'
}

/**
 * Build an {@link ExecPolicy}.
 *
 * Defaults are the **permissive library behavior**: `mode: 'allow'` plus the
 * {@link defaultDenyPatterns} denylist. That is exactly what `run_command` did
 * before this module existed, so `createCoreTools()` with no arguments keeps
 * behaving bit-for-bit as it did (see `lib/tools.ts`). The stricter default
 * lives at the CLI layer instead, where a human is present to be told about it.
 */
export function createExecPolicy(overrides: Partial<ExecPolicy> = {}): ExecPolicy {
  const policy: ExecPolicy = {
    mode: normalizeMode(overrides.mode ?? 'allow'),
    allowlist: Array.isArray(overrides.allowlist)
      ? overrides.allowlist.map((entry) => String(entry))
      : defaultAllowlist(),
    denyPatterns: Array.isArray(overrides.denyPatterns)
      ? [...overrides.denyPatterns]
      : defaultDenyPatterns(),
  }
  if (typeof overrides.approve === 'function') policy.approve = overrides.approve
  return policy
}

/**
 * Highest-precedence executable of a segment. A wrapper (`npx <pkg>`,
 * `pnpm dlx <pkg>`, `yarn dlx <pkg>`) contributes **both** the wrapper and the
 * wrapped package, so `npx evil-pkg` is judged on `evil-pkg` too.
 */
const WRAPPED_PACKAGE_AFTER: Record<string, string | undefined> = {
  npx: '',
  pnpm: 'dlx',
  yarn: 'dlx',
}

/** `NAME=value` env-assignment prefix, e.g. `NODE_ENV=production node x.js`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Split a shell line into the segments a shell would run: `&&`, `||`, `;`,
 * `|`, `&` and newlines all chain commands.
 *
 * Quoting is respected (separators inside `'…'` / `"…"` are literal). Redirection
 * forms are *not* treated as separators: `&>` and `>&` (`2>&1`) are kept in
 * place. An unterminated quote is reported as an error so the caller can refuse
 * rather than guess.
 */
export function splitSegments(line: string): { segments: string[]; error?: string } {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  /** Last non-space character appended to `current` (for `>&` detection). */
  let previous = ''
  let index = 0

  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed.length > 0) segments.push(trimmed)
    current = ''
    previous = ''
  }

  while (index < line.length) {
    const char = line[index]

    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      previous = char
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      previous = char
      index += 1
      continue
    }

    if (char === '\n' || char === '\r') {
      flush()
      index += 1
      continue
    }

    if (char === ';') {
      flush()
      index += 1
      continue
    }

    if (char === '|') {
      flush()
      index += line[index + 1] === '|' ? 2 : 1
      continue
    }

    if (char === '&') {
      if (line[index + 1] === '&') {
        flush()
        index += 2
        continue
      }
      if (line[index + 1] === '>') {
        // `&>` / `&>>` redirection, not a separator.
        current += '&>'
        previous = '>'
        index += 2
        continue
      }
      if (previous === '>') {
        // `>&` / `2>&1` redirection, not a separator.
        current += '&'
        previous = '&'
        index += 1
        continue
      }
      flush()
      index += 1
      continue
    }

    current += char
    if (char !== ' ' && char !== '\t') previous = char
    index += 1
  }

  if (quote !== undefined) {
    return {
      segments,
      error: `unmatched ${quote === '"' ? 'double' : 'single'} quote`,
    }
  }

  flush()
  return { segments }
}

/**
 * Whitespace-tokenize a segment, dropping quote characters so a quoted path
 * stays one token. Returns `undefined` when the segment has an unterminated
 * quote.
 */
function tokenize(segment: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined

  for (const char of segment) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (quote !== undefined) return undefined
  if (started) tokens.push(current)
  return tokens
}

/**
 * Normalize a command token to its executable name: strip surrounding quotes
 * and subshell punctuation, take the basename (`C:\…\node.exe` → `node`,
 * `/usr/bin/node` → `node`), lowercase, and drop a `.exe`/`.cmd`/`.bat` suffix.
 */
export function executableName(token: string): string {
  const unquoted = token.replace(/^['"]+/, '').replace(/['"]+$/, '')
  const unwrapped = unquoted.replace(/^[({]+/, '').replace(/[)}]+$/, '')
  const base = unwrapped.split(/[\\/]/).pop() ?? unwrapped
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

/**
 * Every executable a single segment would launch: the command's own executable
 * plus, for a wrapper, the package it wraps. `undefined` means the segment
 * could not be tokenized (unterminated quote).
 */
export function executablesOf(segment: string): string[] | undefined {
  const tokens = tokenize(segment)
  if (tokens === undefined) return undefined

  let index = 0
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) index += 1

  const first = tokens[index]
  if (first === undefined) return [] // e.g. `FOO=bar` alone: nothing to run

  const name = executableName(first)
  if (name.length === 0) return undefined

  const names = [name]

  // Wrapper handling, kept deliberately simple and documented: we only look at
  // the token immediately after the wrapper (`npx`) or after `<manager> dlx`.
  const wrapMarker = WRAPPED_PACKAGE_AFTER[name]
  if (wrapMarker !== undefined) {
    let cursor = index + 1
    if (wrapMarker !== '' && tokens[cursor] === wrapMarker) cursor += 1
    while (cursor < tokens.length && tokens[cursor].startsWith('-')) cursor += 1
    const wrapped = tokens[cursor]
    if (wrapped !== undefined) {
      const wrappedName = executableName(wrapped)
      if (wrappedName.length > 0) names.push(wrappedName)
    }
  }

  return names
}

function denyPatternsOf(policy: ExecPolicy): { label: string; pattern: RegExp }[] {
  return Array.isArray(policy?.denyPatterns) ? policy.denyPatterns : []
}

function allowlistOf(policy: ExecPolicy): Set<string> {
  const entries = Array.isArray(policy?.allowlist) ? policy.allowlist : []
  return new Set(entries.map((entry) => String(entry).toLowerCase()))
}

/**
 * Decide whether `command` may run under `policy`.
 *
 * Never throws and always resolves: an approver that throws, a malformed
 * policy, or an unparseable command all become a refusal. Order of checks:
 * deny patterns (every mode) → mode policy → `allowlist` segmentation / `ask`
 * approver.
 */
export async function evaluateCommand(
  command: string,
  policy: ExecPolicy,
  ctx: { cwd: string; tool?: string },
): Promise<PolicyDecision> {
  const mode = normalizeMode(policy?.mode)
  const text = typeof command === 'string' ? command : String(command ?? '')
  const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : ''
  const tool = ctx?.tool ?? 'run_command'

  // 1. Deny patterns: ALWAYS, in every mode, including 'allow'.
  for (const entry of denyPatternsOf(policy)) {
    if (!entry || !(entry.pattern instanceof RegExp)) continue
    entry.pattern.lastIndex = 0 // defensive: a global pattern must not carry state
    if (entry.pattern.test(text)) {
      return { allowed: false, mode, reason: 'denied-pattern', detail: `matched ${entry.label}` }
    }
  }

  // 2. Mode policy. `deny` and `allow` need no parsing at all.
  if (mode === 'deny') {
    return {
      allowed: false,
      mode,
      reason: 'denied-mode',
      detail: 'mode "deny" refuses all shell commands',
    }
  }
  if (mode === 'allow') {
    return { allowed: true, mode, reason: 'allowed' }
  }

  // 3. `allowlist`: every segment's executable must be allowlisted.
  if (mode === 'allowlist') {
    const parsed = splitSegments(text)
    if (parsed.error !== undefined) {
      // Cannot confidently parse → refuse (conservative), never guess.
      return {
        allowed: false,
        mode,
        reason: 'denied-not-allowlisted',
        detail: `cannot parse command: ${parsed.error}`,
      }
    }
    const allowlist = allowlistOf(policy)
    for (const segment of parsed.segments) {
      const names = executablesOf(segment)
      if (names === undefined) {
        return {
          allowed: false,
          mode,
          reason: 'denied-not-allowlisted',
          detail: `cannot parse command segment: ${segment}`,
        }
      }
      for (const name of names) {
        if (!allowlist.has(name)) {
          return {
            allowed: false,
            mode,
            reason: 'denied-not-allowlisted',
            detail: `"${name}" is not in the allowlist`,
          }
        }
      }
    }
    return { allowed: true, mode, reason: 'allowed' }
  }

  // 4. `ask`: fail closed when there is nobody to ask.
  const approve = policy?.approve
  if (typeof approve !== 'function') {
    return {
      allowed: false,
      mode,
      reason: 'denied-no-approver',
      detail: 'no approver is configured for mode "ask"',
    }
  }

  let approved = false
  try {
    approved = (await approve({ command: text, cwd, tool })) === true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      allowed: false,
      mode,
      reason: 'denied-by-approver',
      detail: `approver failed: ${message}`,
    }
  }

  if (approved) return { allowed: true, mode, reason: 'allowed' }
  return { allowed: false, mode, reason: 'denied-by-approver', detail: 'denied by the approver' }
}

/**
 * Resolve the policy mode from `ZOO_EXEC_POLICY`.
 *
 * Unknown or empty values fall back to `'allow'`, which is the
 * **backward-compatible** default: an environment that says nothing gets the
 * historical permissive behavior. The stricter default belongs to the CLI.
 * Never throws.
 */
export function execPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExecPolicyMode {
  const raw = env?.ZOO_EXEC_POLICY
  if (typeof raw !== 'string') return 'allow'
  const value = raw.trim().toLowerCase()
  return isMode(value) ? value : 'allow'
}

/** One-line human summary of the active policy, for CLI help and startup logs. */
export function describePolicy(policy: ExecPolicy): string {
  const mode = normalizeMode(policy?.mode)
  const denyCount = denyPatternsOf(policy).length

  switch (mode) {
    case 'deny':
      return `exec-policy=deny — every shell command is refused (${denyCount} deny patterns still checked)`
    case 'allowlist': {
      const allowlist = Array.isArray(policy?.allowlist) ? policy.allowlist : []
      return `exec-policy=allowlist — only allowlisted executables: ${allowlist.join(', ')}`
    }
    case 'ask':
      return typeof policy?.approve === 'function'
        ? `exec-policy=ask — every command is approved interactively (${denyCount} deny patterns always apply)`
        : `exec-policy=ask — no approver configured, so commands are refused (${denyCount} deny patterns always apply)`
    default:
      return `exec-policy=allow — all shell commands permitted except ${denyCount} deny patterns`
  }
}
