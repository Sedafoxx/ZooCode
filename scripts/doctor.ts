#!/usr/bin/env tsx
/**
 * ZooCode environment doctor CLI.
 *
 * Verifies the local toolchain (node, npm, git, npx) plus ZooCode's own repo
 * state, and prints a report through the shared logger.
 *
 * Usage: tsx scripts/doctor.ts [--json]
 *
 *   (no args)  Human-readable report; exits 0 if healthy, 1 otherwise.
 *   --json     Print only the DoctorReport JSON to stdout.
 */

import { runDoctor } from '../lib/doctor.js'
import * as logger from '../lib/logger.js'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Usage: tsx scripts/doctor.ts [--json]

  Verify the local toolchain (node, npm, git, npx) and ZooCode repo state.

  Options:
    --json       Print only the DoctorReport JSON to stdout
    -h, --help   Show this help
  `)
  process.exit(0)
}

const json = args.includes('--json')

const result = runDoctor()

if (!result.ok || !result.data) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: result.error ?? 'doctor failed' }))
  } else {
    logger.error(result.error ?? 'Doctor failed')
  }
  process.exit(1)
}

const report = result.data

if (json) {
  console.log(JSON.stringify(report))
  process.exit(report.healthy ? 0 : 1)
}

logger.header('Environment Doctor')
for (const check of report.checks) {
  const suffix = check.detail ? ` — ${check.detail}` : ''
  if (check.status === 'ok') {
    logger.success(`${check.name}${suffix}`)
  } else if (check.status === 'warn') {
    logger.warn(`${check.name}${suffix}`)
  } else {
    logger.error(`${check.name}${suffix}`)
  }
}

const { ok, warn, fail } = report.summary
if (report.healthy) {
  logger.step(`Healthy — ${ok} ok, ${warn} warn, ${fail} fail`)
} else {
  logger.step(`Needs attention — ${ok} ok, ${warn} warn, ${fail} fail`)
}

process.exit(report.healthy ? 0 : 1)
