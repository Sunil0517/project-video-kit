#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Browser, importConfig } from './browser.ts'

// Signs in with a tour config and screenshots app pages at the recording
// viewport, for planning scenes and checking sample data.
//
//   node snap.ts <config> /dashboard /reports?tab=2 [--full]

const args = process.argv.slice(2)
const full = args.includes('--full')
const [configArg, ...paths] = args.filter(a => a !== '--full')
if (!configArg || !paths.length) {
  console.error('usage: node snap.ts <config> <path> [path...] [--full]')
  process.exit(1)
}

const { config } = await importConfig(configArg).catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
const viewport = config.viewport
const outDir = path.join(os.tmpdir(), 'product-video-snaps')
mkdirSync(outDir, { recursive: true })

const page = await Browser.launch({
  viewport,
  pixelRatio: 1,
  profileDir: path.join(os.tmpdir(), 'product-video-snap-profile'),
  port: 9334
})
try {
  await page.colorScheme('dark')
  if (config.signIn) await config.signIn({ page, baseUrl: config.baseUrl })
  for (const p of paths) {
    await page.goto(new URL(p, config.baseUrl).href, { busy: config.busy })
    const height = full
      ? Math.min(await page.eval<number>('document.documentElement.scrollHeight'), 6000)
      : viewport.height
    const shot = await page.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      captureBeyondViewport: full,
      clip: { x: 0, y: 0, width: viewport.width, height, scale: 1 }
    })
    const file = path.join(outDir, `${p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}.jpg`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(file)
  }
} finally {
  await page.close()
}
process.exit(0)
