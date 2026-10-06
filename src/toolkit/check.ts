#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Checks a finished video: finds one-frame flashes and harsh brightness
// jumps, and writes a contact sheet to look at. Exits 1 when it finds a flash.

const file = process.argv[2]
if (!file || !existsSync(file)) {
  console.error('usage: node check.ts <video>')
  process.exit(1)
}

const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd })
  if (r.error) throw new Error(`${cmd} is not installed.`)
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim()}`)
  return r.stdout
}

// ffmpeg filters treat \ : and ' in a path as syntax, so the stats file gets a
// plain name and ffmpeg runs inside the temp folder to write it
const name = `product-video-check-${path.parse(file).name.replace(/[^\w-]+/g, '-')}`
const base = path.join(os.tmpdir(), name)
const stats = `${base}-yavg.txt`
run(
  'ffmpeg',
  [
    '-v',
    'error',
    '-i',
    path.resolve(file),
    '-vf',
    `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${name}-yavg.txt`,
    '-f',
    'null',
    '-'
  ],
  os.tmpdir()
)
const luma = [...readFileSync(stats, 'utf8').matchAll(/YAVG=([\d.]+)/g)].map(m => Number(m[1]))
const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]))
const fps = luma.length / duration
const at = (i: number) => `${(i / fps).toFixed(2)}s`

// A flash: one frame far brighter or darker than both neighbors
const FLASH = 25
const flashes: string[] = []
for (let i = 1; i < luma.length - 1; i++) {
  const up = luma[i] - luma[i - 1] > FLASH && luma[i] - luma[i + 1] > FLASH
  const down = luma[i - 1] - luma[i] > FLASH && luma[i + 1] - luma[i] > FLASH
  if (up || down) flashes.push(at(i))
}
const steps = luma
  .slice(1)
  .map((v, i) => ({ change: Math.abs(v - luma[i]), time: at(i + 1) }))
  .sort((a, b) => b.change - a.change)
const harsh = steps.filter(s => s.change > FLASH)

const sheet = `${base}-sheet.jpg`
// Up to 25 frames, at most one a second, in a grid sized to fit them
const count = Math.min(25, Math.max(1, Math.floor(duration)))
const cols = Math.min(5, count)
run('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  file,
  '-vf',
  `fps=${count}/${duration.toFixed(3)},scale=480:-1,tile=${cols}x${Math.ceil(count / cols)}:padding=4`,
  '-frames:v',
  '1',
  sheet
])

console.log(
  JSON.stringify(
    {
      file,
      seconds: Number(duration.toFixed(1)),
      frames: luma.length,
      flashes,
      harshJumps: harsh.map(s => `${s.time} (${s.change.toFixed(0)})`),
      largestChange: `${steps[0]?.change.toFixed(1)} at ${steps[0]?.time}`,
      contactSheet: sheet,
      verdict: flashes.length
        ? 'Fix before publishing: one-frame flashes found.'
        : harsh.length
          ? 'No flashes. Look at the harsh jumps: hard cuts are fine, stuttering fades are not.'
          : 'No flashes or harsh jumps.'
    },
    null,
    2
  )
)
process.exit(flashes.length ? 1 : 0)
