#!/usr/bin/env tsx
/**
 * Quick code analysis for a target directory.
 *
 * Usage: tsx scripts/analyze.ts <target-dir>
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectFiles, getProjectSummary } from '../lib/files.js'
import * as logger from '../lib/logger.js'

function usage(): never {
  console.log(`
  Usage: tsx scripts/analyze.ts <target-dir>

  Analyzes a project directory and prints a summary.

  Example:
    tsx scripts/analyze.ts ../DAW-ai
  `)
  process.exit(1)
}

const rawTarget = process.argv[2]
if (!rawTarget) usage()

const targetDir = resolve(rawTarget)

if (!existsSync(targetDir)) {
  logger.error(`Directory not found: ${targetDir}`)
  process.exit(1)
}

if (!statSync(targetDir).isDirectory()) {
  logger.error(`Not a directory: ${targetDir}`)
  process.exit(1)
}

logger.header(`Analysis: ${rawTarget}`)

const summary = getProjectSummary(targetDir)

logger.info(`Total files:     ${summary.files}`)
logger.info(`Total lines:     ${summary.lines}`)
logger.dim('')

logger.step('Files by extension')
const sorted = Object.entries(summary.extensions).sort((a, b) => b[1] - a[1])
for (const [ext, count] of sorted) {
  logger.info(`.${ext}: ${count} files`)
}

logger.dim('')
logger.success('Analysis complete')
