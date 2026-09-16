/**
 * Turn raw verification output into a structured verdict.
 *
 * Why this exists: an observed run saw its own `--verify-cmd` exit non-zero, and
 * read that as "the feature is broken" — it then spent five steps probing APIs
 * before the real cause was found by hand. The output it had was a wall of text
 * whose meaning was in two words. `summariseVerify()` extracts those words, so a
 * red gate reports "3 of 5 checks failed: <names>" instead of a bare exit code,
 * and the same verdict can be put in front of the model as a baseline.
 *
 * Pure and dependency-free: parsing is the part worth testing, so it is separate
 * from anything that spawns a process.
 */

export interface VerifySummary {
  command: string
  exitCode: number
  /** Lines beginning with PASS (vitest/oxlint style output is tolerated by exit code). */
  passed: number
  failed: number
  /** The names of failing checks, stripped of their PASS/FAIL prefix. */
  failedChecks: string[]
  /** Number of NOTE lines, reported so "nothing was rejected" style notes are visible. */
  notes: number
  /** True when the output carried no PASS/FAIL lines at all. */
  unstructured: boolean
  /** Last few non-empty lines, so a compiler error is still readable. */
  tail: string
}

const PASS_RE = /^\s*(?:PASS|ok|✓|√)\b[:\s]*(.*)$/i
const FAIL_RE = /^\s*(?:FAIL|failed|✗|✕|×)\b[:\s]*(.*)$/i
const NOTE_RE = /^\s*NOTE\b/i
/** Vitest marks failures with a leading ✕ too, sometimes indented inside a test name. */
const VITEST_FAIL_RE = /^\s*(?:✕|×)\s+(.+)$/

/** Last `count` non-empty lines, joined. */
export function tailLines(output: string, count = 8): string {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

/**
 * Parse verification output. Defensive by contract: an unrecognised format is
 * reported as `unstructured` with the exit code deciding pass/fail, never guessed.
 */
export function summariseVerify(command: string, exitCode: number, output: string): VerifySummary {
  const text = String(output ?? '')
  const lines = text.split(/\r?\n/)

  let passed = 0
  let failed = 0
  let notes = 0
  const failedChecks: string[] = []

  for (const line of lines) {
    if (NOTE_RE.test(line)) {
      notes += 1
      continue
    }
    // Checked before PASS/FAIL: a vitest failure marker can wrap the name.
    const vitest = VITEST_FAIL_RE.exec(line)
    if (vitest !== null) {
      failed += 1
      const name = vitest[1].trim()
      if (name.length > 0) failedChecks.push(name)
      continue
    }
    const fail = FAIL_RE.exec(line)
    if (fail !== null) {
      failed += 1
      const name = (fail[1] ?? '').trim()
      if (name.length > 0) failedChecks.push(name)
      continue
    }
    if (PASS_RE.test(line)) passed += 1
  }

  const unstructured = passed === 0 && failed === 0
  // Without named failures there is still a verdict: the exit code. Say so, and
  // keep the tail so a compiler error is not lost.
  if (unstructured && exitCode !== 0) {
    const tail = tailLines(text, 3)
    if (tail.length > 0) failedChecks.push(tail)
    failed = 1
  }

  return {
    command,
    exitCode,
    passed,
    failed,
    failedChecks,
    notes,
    unstructured,
    tail: tailLines(text, 12),
  }
}

/** One-line verdict for logs and prompts. */
export function describeVerify(summary: VerifySummary): string {
  const STATUS = summary.exitCode === 0 ? 'passed' : 'FAILED'
  if (summary.unstructured) {
    return `verify ${STATUS} (exit ${summary.exitCode}, no PASS/FAIL lines: output is unstructured)`
  }
  const parts = [`verify ${STATUS} (exit ${summary.exitCode})`, `${summary.passed} passed`, `${summary.failed} failed`]
  if (summary.failedChecks.length > 0) {
    parts.push(`failing: ${summary.failedChecks.slice(0, 8).join('; ')}`)
  }
  return parts.join(' — ')
}

/**
 * The pre-flight block: what the verification command does BEFORE the agent
 * touches anything. Distinguishing "already broken" from "you broke it" is the
 * single cheapest way to stop an agent chasing a pre-existing failure.
 */
export function formatBaseline(summary: VerifySummary): string {
  const head = [
    '## Verification baseline (run before you started)',
    `- Command: ${summary.command}`,
    `- ${describeVerify(summary)}`,
  ]
  if (summary.exitCode === 0) {
    head.push('- It passes right now. Keep it passing: any failure you see later is your change.')
  } else {
    head.push(
      '- It FAILS right now, before any edit of yours. These are pre-existing:',
      ...summary.failedChecks.slice(0, 5).map((name) => `  - ${name}`),
      '- Do not try to fix unrelated pre-existing failures. Do not report success while they remain, either — ' +
        'state plainly which failures you inherited.',
    )
  }
  return head.join('\n')
}
