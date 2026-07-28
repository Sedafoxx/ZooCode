import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

await page.goto('https://dimi-time.vercel.app', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

// Get all card titles in the feed
const titles = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*="font-semibold"]')
  return Array.from(els).map(el => el.textContent?.trim()).filter(Boolean).slice(0, 30)
})

console.log('=== Titles in feed ===')
for (const t of titles) console.log(' -', t)

// Take screenshot
await page.screenshot({ path: 'C:/Users/dchy/Documents/VSCode/ZooCode/feed-check.png', fullPage: true })
console.log('\nScreenshot saved!')

await browser.close()
