/**
 * Template registry for ZooCode scaffolding.
 *
 * Each template describes the set of files to scaffold for a new project. The
 * registry is intentionally small and synchronous: templates are pure functions
 * from a project name to a list of file entries.
 */

import type { FileEntry } from './files.js'

export interface Template {
  name: string
  description: string
  files: (name: string) => FileEntry[]
}

export interface TemplateSummary {
  name: string
  description: string
}

/** Name of the default template used when none is specified. */
export const DEFAULT_TEMPLATE = 'base'

// --- Templates ---

const baseTemplate: Template = {
  name: 'base',
  description: 'A minimal TypeScript app scaffold (the ZooCode default).',
  files: (name) => [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name,
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
      content: `# ${name}\n\nA TypeScript project bootstrapped by ZooCode.\n`,
    },
    {
      path: 'src/index.ts',
      content: `/**
 * ${name}
 * Bootstrapped by ZooCode.
 */

function main(): void {
  console.log('Hello from ${name}!')
}

main()
`,
    },
  ],
}

const libTemplate: Template = {
  name: 'lib',
  description: 'A TypeScript library template with tests, lint, and build.',
  files: (name) => [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name,
          private: true,
          version: '0.0.1',
          type: 'module',
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          scripts: {
            build: 'tsc',
            test: 'vitest run',
            'test:watch': 'vitest',
            lint: 'oxlint',
          },
          devDependencies: {
            '@types/node': '^24.0.0',
            oxlint: '^1.71.0',
            typescript: '~6.0.2',
            vitest: '^3.1.0',
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
            verbatimModuleSyntax: true,
            moduleDetection: 'force',
            declaration: true,
            outDir: 'dist',
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
      content: `# ${name}\n\nA TypeScript library bootstrapped by ZooCode.\n`,
    },
    {
      path: 'src/index.ts',
      content: `/**
 * ${name}
 * Bootstrapped by ZooCode.
 */

export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
`,
    },
    {
      path: 'tests/index.test.ts',
      content: `import { describe, it, expect } from 'vitest'
import { greet } from '../src/index.js'

describe('greet', () => {
  it('greets a name', () => {
    expect(greet('Zoo')).toBe('Hello, Zoo!')
  })
})
`,
    },
  ],
}

const cliTemplate: Template = {
  name: 'cli',
  description: 'A TypeScript CLI scaffold with a bin entry.',
  files: (name) => [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name,
          private: true,
          version: '0.0.1',
          type: 'module',
          bin: {
            [name]: './dist/cli.js',
          },
          scripts: {
            build: 'tsc',
            dev: 'tsx watch src/cli.ts',
            lint: 'oxlint',
            test: 'vitest run',
          },
          devDependencies: {
            '@types/node': '^24.0.0',
            oxlint: '^1.71.0',
            tsx: '^4.19.0',
            typescript: '~6.0.2',
            vitest: '^3.1.0',
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
            verbatimModuleSyntax: true,
            moduleDetection: 'force',
            outDir: 'dist',
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
      content: `# ${name}\n\nA TypeScript CLI bootstrapped by ZooCode.\n`,
    },
    {
      path: 'src/cli.ts',
      content: `#!/usr/bin/env node
/**
 * ${name} CLI
 * Bootstrapped by ZooCode.
 */

function main(): void {
  const args = process.argv.slice(2)
  console.log(\`Hello from ${name}! Args: \${args.join(' ')}\`)
}

main()
`,
    },
  ],
}

const templates: Record<string, Template> = {
  [baseTemplate.name]: baseTemplate,
  [libTemplate.name]: libTemplate,
  [cliTemplate.name]: cliTemplate,
}

// --- Public API ---

/**
 * List metadata for all registered templates.
 */
export function listTemplates(): TemplateSummary[] {
  return Object.values(templates).map((t) => ({ name: t.name, description: t.description }))
}

/**
 * Look up a template by name. Case-insensitive and whitespace-tolerant; falls
 * back to `{ ok: false }` with an error for unknown names.
 */
export function getTemplate(name: string): { ok: boolean; data?: Template; error?: string } {
  const key = (name ?? '').trim().toLowerCase()
  const template = templates[key]
  if (!template) {
    return { ok: false, error: `Unknown template: ${name}` }
  }
  return { ok: true, data: template }
}

/**
 * Resolve the concrete files to scaffold for a project name using a template.
 * Never throws: errors are caught and returned as `{ ok: false }`.
 */
export function resolveTemplateFiles(
  name: string,
  projectName: string,
): { ok: boolean; data?: FileEntry[]; error?: string } {
  const found = getTemplate(name)
  if (!found.ok) {
    return { ok: false, error: found.error }
  }
  try {
    return { ok: true, data: found.data!.files(projectName) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to resolve template "${name}": ${message}` }
  }
}
