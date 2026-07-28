#!/usr/bin/env node
// Quick smoke test of the deployed site
const BASE = 'https://dimi-time-ddboxots8-sedafoxxs-projects.vercel.app'

async function test() {
  const results = []
  for (const path of ['/', '/calendar', '/plan', '/api/events?past=true', '/api/memories?recent=true']) {
    try {
      const res = await fetch(`${BASE}${path}`, { redirect: 'follow' })
      const text = await res.text()
      results.push({ path, status: res.status, length: text.length, ok: res.ok })
      console.log(`${res.status} ${path} (${text.length} chars)`)
    } catch (e) {
      results.push({ path, status: 'ERR', error: e.message })
      console.log(`ERR ${path}: ${e.message}`)
    }
  }
  return results
}

test().then(() => console.log('\nDone')).catch(console.error)
