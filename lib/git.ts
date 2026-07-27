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
