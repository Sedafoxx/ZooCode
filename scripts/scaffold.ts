#!/usr/bin/env tsx
/**
 * Scaffold a new TypeScript project from the base template.
 *
 * Usage: tsx scripts/scaffold.ts <project-name> [target-dir]
 *
 * If target-dir is omitted, the project is created in the VSCode directory
 * alongside the other projects.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { init, initialCommit, isGitRepo } from '../lib/git.js'
import { ensureDir, scaffoldFromTemplate, type FileEntry } from '../lib/files.js'
import * as logger from '../lib/logger.js'

const DEFAULT_PARENT = 'C:/Users/dchy/Documents/VSCode'

function usage(): never {
  console.log(`
  Usage: tsx scripts/scaffold.ts <project-name> [target-dir]

  Creates a new TypeScript project from the base template.

  Arguments:
    project-name   Name of the project (and directory)
    target-dir     Parent directory (default: ${DEFAULT_PARENT})

  Example:
    tsx scripts/scaffold.ts my-cool-project
    tsx scripts/scaffold.ts my-cool-project C:/Users/dchy/Desktop
  `)
  process.exit(1)
}

const projectName = process.argv[2]
if (!projectName) usage()

const targetParent = process.argv[3] || DEFAULT_PARENT
const targetDir = join(targetParent, projectName)

if (existsSync(targetDir)) {
  logger.error(`Directory already exists: ${targetDir}`)
  process.exit(1)
}

logger.header(`Scaffolding "${projectName}"`)
logger.info(`Target: ${targetDir}`)

// --- Template files ---
const files: FileEntry[] = [
  {
    path: 'package.json',
    content: JSON.stringify(
      {
        name: projectName,
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
          dev: 'tsx watch src/index.ts',
          lint: 'oxlint',
        },
        devDependencies: {
          '@types/node': '^24.0.0',
          oxlint: '^1.71.0',
          tsx: '^4.19.0',
          typescript: '~6.0.2',
        },
      },
      null,
      2,
    ),
  },
  {
    path: 'tsconfig.json',
    content: JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          lib: ['ES2023'],
          module: 'esnext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          moduleDetection: 'force',
          noEmit: true,
          erasableSyntaxOnly: true,
          strict: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src'],
      },
      null,
      2,
    ),
  },
  {
    path: '.gitignore',
    content: 'node_modules/\ndist/\n*.tsbuildinfo\n',
  },
  {
    path: 'README.md',
    content: `# ${projectName}\n\nA TypeScript project bootstrapped by ZooCode.\n`,
  },
  {
    path: 'src/index.ts',
    content: `/**
 * ${projectName}
 * Bootstrapped by ZooCode.
 */

function main(): void {
  console.log('Hello from ${projectName}!')
}

main()
`,
  },
]

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
