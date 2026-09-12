#!/usr/bin/env tsx
/**
 * Cross-project code search using PowerShell Select-String.
 *
 * Usage: tsx scripts/search.ts <pattern> [--ext .ts] [--max 20] [--project <name>]
 *
 * Examples:
 *   tsx scripts/search.ts "export function"
 *   tsx scripts/search.ts "class Audio" --ext .ts
 *   tsx scripts/search.ts "TODO|FIXME" --max 10
 *   tsx scripts/search.ts "export.*function" --project DAW-ai
 */

import { execSync } from 'node:child_process'
import * as logger from '../lib/logger.js'

const VSCodeDir = 'C:/Users/dchy/Documents/VSCode'

function usage(): never {
  console.log(`
  Usage: tsx scripts/search.ts <pattern> [options]

  Search across all projects for a regex pattern.

  Options:
    --ext <ext>    File extension filter (e.g., .ts, .js, .tsx)
    --max <n>      Max results per project (default: 20)
    --project <p>  Search only a specific project directory name

  Examples:
    tsx scripts/search.ts "function main"
    tsx scripts/search.ts "class Audio" --ext .ts
    tsx scripts/search.ts "TODO|FIXME" --max 10
    tsx scripts/search.ts "export function" --project DAW-ai
  `)
  process.exit(1)
}

const pattern = process.argv[2]
if (!pattern) usage()

const args = process.argv.slice(3)
let extFilter = '.ts'
let maxResults = 20
let projectFilter = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ext' && args[i + 1]) extFilter = args[++i]
  else if (args[i] === '--max' && args[i + 1]) maxResults = parseInt(args[++i])
  else if (args[i] === '--project' && args[i + 1]) projectFilter = args[++i]
  else usage()
}

logger.header(`Cross-Project Search: "${pattern}"`)

// Get list of project directories
const projectDirs: string[] = projectFilter
  ? [`${VSCodeDir}/${projectFilter}`]
  : execSync(
      `powershell -Command "Get-ChildItem '${VSCodeDir}' -Directory | Where-Object { $_.Name -notmatch '^\\.' } | Select-Object -ExpandProperty FullName"`,
      { encoding: 'utf-8' }
    )
      .trim()
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)

for (const dir of projectDirs) {
  const projectName = dir.split('\\').pop()

  // Build PowerShell command with proper quoting
  const psCmd =
    `Get-ChildItem "${dir}" -Recurse -Include "*${extFilter}" -File` +
    ` | Where-Object { $_.DirectoryName -notmatch '\\\\node_modules\\\\|\\\\.git\\\\|\\\\.claude\\\\|\\\\graphify-out\\\\' }` +
    ` | Select-String -List -Pattern '${pattern.replace(/'/g, "''")}'` +
    ` | Select-Object -First ${maxResults}` +
    ` | ForEach-Object { $_.Filename + ' (' + $_.LineNumber + '): ' + $_.Line.Trim() }`

  try {
    const result = execSync(`powershell -Command "${psCmd.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
    })

    const lines = result.trim().split(/\r?\n/).filter(Boolean)
    if (lines.length > 0) {
      logger.step(projectName!)
      for (const line of lines.slice(0, maxResults)) {
        console.log(`  ${line}`)
      }
      if (lines.length > maxResults) {
        logger.dim(`  ... and ${lines.length - maxResults} more`)
      }
    }
  } catch {
    // No matches or error — skip silently
  }
}

logger.dim('')
logger.success('Search complete')
