#!/usr/bin/env tsx
/**
 * Conventional commit CLI.
 *
 * Stages all changes and creates a conventional commit, printing progress
 * through the shared logger.
 *
 * Usage: tsx scripts/commit.ts [--type <type>] [--scope <scope>] [--dir <path>] [--dry-run] <message>
 *
 * Examples:
 *   tsx scripts/commit.ts "fix login bug"
 *   tsx scripts/commit.ts --type feat --scope cli "add doctor command"
 *   tsx scripts/commit.ts --type feat --scope cli "add doctor command" --dry-run
 */

import { commit, getStatus, shortLog, stageAll } from '../lib/git.js'
import * as logger from '../lib/logger.js'

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'perf', 'build', 'ci', 'style']

function usage(): never {
  console.log(`
  Usage: tsx scripts/commit.ts [options] <message>

  Stage all changes and create a conventional commit.

  Options:
    --type <type>    Commit type (default: chore)
                     One of: ${TYPES.join(', ')}
    --scope <scope>  Optional scope, e.g. "cli"
    --dir <path>     Target git repository (default: current directory)
    --dry-run        Print what would be done without committing
    -h, --help       Show this help

  Examples:
    tsx scripts/commit.ts "fix login bug"
    tsx scripts/commit.ts --type feat --scope cli "add doctor command"
    tsx scripts/commit.ts --type feat --scope cli "add doctor command" --dry-run
  `)
  process.exit(1)
}

const args = process.argv.slice(2)
let type = 'chore'
let scope: string | undefined
let dir = process.cwd()
let dryRun = false
const positional: string[] = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--type' && args[i + 1]) {
    type = args[++i].trim()
    if (!TYPES.includes(type)) {
      logger.error(`Unknown commit type "${type}". Valid types: ${TYPES.join(', ')}`)
      process.exit(1)
    }
  } else if (arg === '--scope' && args[i + 1]) {
    scope = args[++i].trim() || undefined
  } else if (arg === '--dir' && args[i + 1]) {
    dir = args[++i]
  } else if (arg === '--dry-run') {
    dryRun = true
  } else if (arg === '--help' || arg === '-h') {
    usage()
  } else {
    positional.push(arg)
  }
}

const message = positional.join(' ').trim()
if (!message) usage()

const fullMessage = scope ? `${type}(${scope}): ${message}` : `${type}: ${message}`

logger.header('Conventional Commit')
logger.dim(`Directory: ${dir}`)
logger.dim(`Message:   ${fullMessage}`)

const statusResult = getStatus(dir)
if (!statusResult.ok) {
  logger.error(statusResult.error ?? 'Failed to read git status')
  process.exit(1)
}

const changed = statusResult.data ?? []
logger.step('Changed files')
if (changed.length === 0) {
  logger.warn('No changes detected — nothing to commit')
  process.exit(0)
}
for (const file of changed) {
  logger.dim(`  ${file.status.padEnd(2)}  ${file.path}`)
}

if (dryRun) {
  logger.step('Dry run — no changes were made')
  logger.info(`Planned: git commit -m "${fullMessage}"`)
  logger.success('Dry run complete')
  process.exit(0)
}

logger.step('Staging all changes')
const stageResult = stageAll(dir)
if (!stageResult.ok) {
  logger.error(stageResult.error ?? 'Failed to stage changes')
  process.exit(1)
}
logger.success(`Staged ${stageResult.data?.staged ?? 0} file(s)`)

logger.step('Committing')
const commitResult = commit(dir, fullMessage)
if (!commitResult.ok) {
  logger.error(commitResult.error ?? 'Failed to create commit')
  process.exit(1)
}
const shortHash = commitResult.data?.hash.slice(0, 8) ?? '????????'
logger.success(`${shortHash} ${commitResult.data?.message ?? fullMessage}`)

const logResult = shortLog(dir, 5)
if (logResult.ok && (logResult.data?.length ?? 0) > 1) {
  logger.step('Recent commits')
  for (const line of logResult.data ?? []) {
    logger.dim(`  ${line}`)
  }
}
