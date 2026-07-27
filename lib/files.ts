/**
 * File-system helpers for scaffolding and project manipulation.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface FileEntry {
  path: string
  content: string
}

/**
 * Ensure a directory exists (recursive).
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Write a file, ensuring its parent directory exists.
 */
export function writeFile(path: string, content: string): void {
  const dir = path.includes('/') || path.includes('\\')
    ? path.substring(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    : '.'
  ensureDir(dir)
  writeFileSync(path, content, 'utf-8')
}

/**
 * Read a file's contents as a string.
 */
export function readFile(path: string): string {
  return readFileSync(path, 'utf-8')
}

/**
 * Recursively collect all file paths under a directory, optionally filtered by extension.
 */
export function collectFiles(dir: string, extension?: string): string[] {
  const results: string[] = []

  function walk(current: string): void {
    const entries = readdirSync(current)
    for (const entry of entries) {
      const fullPath = join(current, entry)
      const stats = statSync(fullPath)
      if (stats.isDirectory()) {
        // skip node_modules and .git
        if (entry === 'node_modules' || entry === '.git') continue
        walk(fullPath)
      } else {
        if (!extension || fullPath.endsWith(extension)) {
          results.push(fullPath)
        }
      }
    }
  }

  walk(dir)
  return results
}

/**
 * Get a summary of all files in a project directory.
 */
export function getProjectSummary(root: string): { files: number; lines: number; extensions: Record<string, number> } {
  const allFiles = collectFiles(root)
  let lines = 0
  const extensions: Record<string, number> = {}

  for (const file of allFiles) {
    const ext = file.substring(file.lastIndexOf('.') + 1)
    extensions[ext] = (extensions[ext] || 0) + 1

    try {
      const content = readFileSync(file, 'utf-8')
      lines += content.split('\n').length
    } catch {
      // skip binary files
    }
  }

  return {
    files: allFiles.length,
    lines,
    extensions,
  }
}

/**
 * Copy template files into a target directory, renaming as specified.
 * `files` is an array of {path, content} — relative paths will be resolved under `targetDir`.
 */
export function scaffoldFromTemplate(targetDir: string, files: FileEntry[]): void {
  ensureDir(targetDir)
  for (const file of files) {
    const fullPath = join(targetDir, file.path)
    writeFile(fullPath, file.content)
  }
}
