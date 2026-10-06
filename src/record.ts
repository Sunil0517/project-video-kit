#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Browser, importConfig, workDirFor } from './toolkit/browser.ts'
import { Stage } from './toolkit/stage.ts'

// Records the raw app clips listed in the config. The compositor (render.ts)
// frames, times and animates them afterwards.
//
//   node src/video/record.ts src/video/tour.config.ts [clip keys...]

const [configArg, ...keys] = process.argv.slice(2)
if (!configArg) {
  console.error('usage: node record.ts <config> [clip keys...]')
  process.exit(1)
}

const { configPath, config } = await importConfig(configArg)
const workDir = workDirFor(configPath, config)
const encoderCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
if (encoderCheck.error || encoderCheck.status !== 0)
  throw new Error('ffmpeg is required to record clips. Install it and add it to PATH.')
const unknown = keys.filter(k => !config.clips.some(c => c.key === k))
if (unknown.length) throw new Error(`Unknown clips: ${unknown.join(', ')}.`)

const alive = await fetch(config.baseUrl).then(
  r => r.status < 500,
  () => false
)
if (!alive) throw new Error(`Nothing answers at ${config.baseUrl}. Start the app first.`)

/**
 * Encodes recorded frames at their real timing into a 30 fps clip. Short GOPs
 * keep the compositor's frame-by-frame seeks fast. Screencast JPEGs are full
 * range, so convert to the limited-range BT.709 every web video uses.
 */
function encode(dir: string, file: string) {
  const { width, height } = config.viewport
  const r = spawnSync(
    'ffmpeg',
    [
      ...['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')],
      '-vf',
      `fps=${config.output.fps},scale=${width * config.pixelRatio}:${height * config.pixelRatio}:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p`,
      ...['-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-g', '10', '-bf', '0'],
      ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
      file
    ],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`ffmpeg failed to encode ${file}: ${r.stderr}`)
}

const page = await Browser.launch({
  viewport: config.viewport,
  pixelRatio: config.pixelRatio,
  profileDir: path.join(workDir, 'profile')
})
const stage = new Stage(page, {
  hide: config.hide,
  css: config.css,
  pace: config.pace,
  pixelRatio: config.pixelRatio,
  viewport: config.viewport
})

try {
  await page.colorScheme('dark')
  if (config.signIn) await config.signIn({ page, baseUrl: config.baseUrl })
  mkdirSync(path.join(workDir, 'clips'), { recursive: true })
  for (const clip of config.clips.filter(c => !keys.length || keys.includes(c.key))) {
    const target = typeof clip.path === 'string' ? clip.path : await clip.path(page, config.baseUrl)
    await page.goto(new URL(target, config.baseUrl).href, { busy: config.busy })
    if (config.prepare) await config.prepare(page)
    await stage.inject({ cursor: clip.cursor !== false })
    const frames = path.join(workDir, 'frames', clip.key)
    await stage.record(frames)
    await clip.act(stage, page)
    const { seconds, marks } = await stage.stop()
    const file = path.join(workDir, 'clips', `${clip.key}.mp4`)
    encode(frames, file)
    writeFileSync(file.replace(/\.mp4$/, '.json'), JSON.stringify({ seconds, marks }, null, 2))
    console.log(`Recorded ${clip.key}: ${seconds.toFixed(1)}s ${JSON.stringify(marks)}`)
  }
} finally {
  await page.close()
}
process.exit(0)
