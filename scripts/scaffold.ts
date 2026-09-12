#!/usr/bin/env tsx
/**
 * Scaffold a new TypeScript project from a registered template.
 *
 * Usage: tsx scripts/scaffold.ts [--template <name>] <project-name> [target-dir]
 *
 * If target-dir is omitted, the project is created in the VSCode directory
 * alongside the other projects.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { init, initialCommit, isGitRepo } from '../lib/git.js'
import { scaffoldFromTemplate } from '../lib/files.js'
import * as logger from '../lib/logger.js'
import { resolveTemplateFiles, listTemplates, DEFAULT_TEMPLATE } from '../lib/templates.js'

const DEFAULT_PARENT = 'C:/Users/dchy/Documents/VSCode'

function usage(): never {
  const templates = listTemplates()
    .map((t) => `  ${t.name.padEnd(12)} ${t.description}`)
    .join('\n')
  console.log(`
  Usage: tsx scripts/scaffold.ts [--template <name>] <project-name> [target-dir]

  Creates a new TypeScript project from a registered template.

  Arguments:
    project-name   Name of the project (and directory)
    target-dir     Parent directory (default: ${DEFAULT_PARENT})

  Options:
    --template     Template to use (default: ${DEFAULT_TEMPLATE})

  Templates:
${templates}

  Example:
    tsx scripts/scaffold.ts my-cool-project
    tsx scripts/scaffold.ts --template lib my-lib
  `)
  process.exit(1)
}

// --- Parse arguments: --template <name> plus positional <project-name> [target-dir] ---
const rawArgs = process.argv.slice(2)
let templateName = DEFAULT_TEMPLATE
const positionals: string[] = []

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]
  if (arg === '--template') {
    const value = rawArgs[i + 1]
    if (!value || value.startsWith('--')) {
      logger.error('Missing value for --template')
      usage()
    }
    templateName = value
    i++
  } else if (arg.startsWith('--template=')) {
    templateName = arg.slice('--template='.length)
  } else {
    positionals.push(arg)
  }
}

const projectName = positionals[0]
if (!projectName) usage()

const targetParent = positionals[1] || DEFAULT_PARENT
const targetDir = join(targetParent, projectName)

if (existsSync(targetDir)) {
  logger.error(`Directory already exists: ${targetDir}`)
  process.exit(1)
}

logger.header(`Scaffolding "${projectName}"`)
logger.info(`Target: ${targetDir}`)
logger.info(`Template: ${templateName}`)

// --- Resolve template files ---
const resolved = resolveTemplateFiles(templateName, projectName)
if (!resolved.ok) {
  logger.error(resolved.error ?? `Unknown template: ${templateName}`)
  process.exit(1)
}
const files = resolved.data!

// --- Execute ---
logger.step('Creating project structure...')
scaffoldFromTemplate(targetDir, files)
logger.success('Project files created')

logger.step('Initializing git repository...')
if (!isGitRepo(targetDir)) {
  init(targetDir)
  initialCommit(targetDir)
  logger.success('Git repo initialized with initial commit')
}

logger.step('Installing dependencies...')
const { execSync } = await import('node:child_process')
execSync('npm install', { cwd: targetDir, stdio: 'inherit' })

logger.success('Done!')
logger.info(`cd ${projectName} && npm run dev`)
