/**
 * Git automation helpers.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const defaultOptions: ExecSyncOptions = {
  stdio: 'pipe',
  encoding: 'utf-8',
}

/**
 * Check if a directory is already a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/**
 * Initialize a new git repository in the given directory.
 */
export function init(dir: string): void {
  execSync('git init', { cwd: dir, ...defaultOptions })
}

/**
 * Stage all files and create the initial commit.
 */
export function initialCommit(dir: string, message = 'Initial commit'): void {
  execSync('git add -A', { cwd: dir, ...defaultOptions })
  execSync(`git commit -m "${message}"`, { cwd: dir, ...defaultOptions })
}

/**
 * Get the current git status (porcelain format).
 */
export function status(dir: string): string {
  return execSync('git status --porcelain', { cwd: dir, ...defaultOptions }) as string
}

// --- Additive extensions (conventional commits & structured status) ---------

export interface ChangedFile {
  path: string
  /** One-char porcelain status, e.g. 'M', 'A', 'D', '??' (or 'MM' for staged+unstaged). */
  status: string
  /** Whether the change appears in the index (staged) column. */
  staged: boolean
  untracked: boolean
}

export interface CommitInfo {
  hash: string
  message: string
}

/** Extract stderr text (or message) from a thrown execSync error. */
function execErrorText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr
    if (stderr !== undefined) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : String(stderr)
      if (text.trim()) return text.trim()
    }
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Parse `git status --porcelain` output into structured file entries.
 * Pure function — no side effects.
 */
export function parseStatus(raw: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (line.length < 3) continue
    const index = line[0]
    const worktree = line[1]
    files.push({
      path: line.substring(3),
      status: index === ' ' ? worktree : worktree === ' ' ? index : index + worktree,
      staged: index !== ' ' && index !== '?',
      untracked: line.startsWith('??'),
    })
  }
  return files
}

/**
 * Run `git status --porcelain` and parse the result. Never throws.
 */
export function getStatus(dir: string): { ok: boolean; data?: ChangedFile[]; error?: string } {
  try {
    const raw = execSync('git status --porcelain', { cwd: dir, ...defaultOptions }) as string
    return { ok: true, data: parseStatus(raw) }
  } catch (err) {
    return { ok: false, error: execErrorText(err) }
  }
}

/**
 * Stage all changes (`git add -A`) and report how many files are staged.
 * Never throws.
 */
export function stageAll(dir: string): { ok: boolean; data?: { staged: number }; error?: string } {
  try {
    execSync('git add -A', { cwd: dir, ...defaultOptions })
    const raw = execSync('git diff --cached --name-only', { cwd: dir, ...defaultOptions }) as string
    const staged = raw.trim() === '' ? 0 : raw.trim().split(/\r?\n/).length
    return { ok: true, data: { staged } }
  } catch (err) {
    return { ok: false, error: execErrorText(err) }
  }
}

/**
 * Create a commit with the given message (callers stage explicitly — this does
 * not run `git add`). Returns the resulting commit hash. Never throws.
 */
export function commit(dir: string, message: string): { ok: boolean; data?: CommitInfo; error?: string } {
  const sanitized = message.trim()
  if (!sanitized) return { ok: false, error: 'Commit message is empty' }
  try {
    const escaped = sanitized.replace(/"/g, '\\"')
    execSync(`git commit -m "${escaped}"`, { cwd: dir, ...defaultOptions })
    const hash = (execSync('git rev-parse HEAD', { cwd: dir, ...defaultOptions }) as string).trim()
    return { ok: true, data: { hash, message: sanitized } }
  } catch (err) {
    return { ok: false, error: execErrorText(err) }
  }
}

/**
 * Recent commit subjects via `git log --oneline -n <count>`. Never throws.
 */
export function shortLog(dir: string, count = 10): { ok: boolean; data?: string[]; error?: string } {
  try {
    const n = Math.max(1, Math.floor(count))
    const raw = execSync(`git log --oneline -n ${n}`, { cwd: dir, ...defaultOptions }) as string
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return { ok: true, data: lines }
  } catch (err) {
    return { ok: false, error: execErrorText(err) }
  }
}
