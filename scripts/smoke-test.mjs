import { chromium } from 'playwright'

const BASE = 'https://dimi-time-ddboxots8-sedafoxxs-projects.vercel.app'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// Test homepage
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: 'C:/Users/dchy/Documents/VSCode/ZooCode/test-homepage.png', fullPage: true })
console.log('1. Homepage loaded:', await page.title())

// Check page content for key elements
const bodyText = await page.textContent('body')
console.log('   Has memories heading:', bodyText.includes('Memories'))
console.log('   Has camera button:', bodyText.includes('📸'))
console.log('   Has bottom nav:', bodyText.includes('Calendar'))

// Test calendar page
await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' })
await page.screenshot({ path: 'C:/Users/dchy/Documents/VSCode/ZooCode/test-calendar.png', fullPage: true })
console.log('2. Calendar loaded:', bodyText.includes('Calendar'))

// Test plan page
await page.goto(`${BASE}/plan`, { waitUntil: 'networkidle' })
await page.screenshot({ path: 'C:/Users/dchy/Documents/VSCode/ZooCode/test-plan.png', fullPage: true })
console.log('3. Plan page loaded')

// Test events API with past=true
const eventsRes = await page.evaluate(() =>
  fetch('/api/events?past=true').then(r => r.json())
)
console.log(`4. Events API (past=true): ${eventsRes.length} events`)

// Test memories API
const memoriesRes = await page.evaluate(() =>
  fetch('/api/memories?recent=true').then(r => r.json())
)
console.log(`5. Memories API: ${memoriesRes.length} memories`)

await browser.close()
console.log('\nDone - check screenshots in ZooCode/')
