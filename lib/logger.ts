/**
 * Pretty console logger with emoji and color support.
 */

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`
}

export function info(msg: string): void {
  console.log(`  ${colorize('cyan', 'ℹ')} ${msg}`)
}

export function success(msg: string): void {
  console.log(`  ${colorize('green', '✔')} ${msg}`)
}

export function warn(msg: string): void {
  console.log(`  ${colorize('yellow', '⚠')} ${msg}`)
}

export function error(msg: string): void {
  console.log(`  ${colorize('red', '✖')} ${msg}`)
}

export function step(msg: string): void {
  console.log(`\n  ${colorize('magenta', '→')} ${colorize('magenta', msg)}`)
}

export function dim(msg: string): void {
  console.log(`  ${colorize('dim', msg)}`)
}

export function header(title: string): void {
  const line = '─'.repeat(Math.min(title.length + 4, 50))
  console.log(`\n  ${colorize('blue', '┌' + line + '┐')}`)
  console.log(`  ${colorize('blue', '│')}  ${colorize('cyan', title)}  ${colorize('blue', '│')}`)
  console.log(`  ${colorize('blue', '└' + line + '┘')}\n`)
}
