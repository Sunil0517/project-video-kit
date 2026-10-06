#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { Browser, importConfig, workDirFor } from './toolkit/browser.ts'
import type { Beat, VideoConfig } from './toolkit/types.ts'

// Renders the tour: plays the composition in compose/ one frame at a time in
// headless Chromium, encodes the frames, mixes the voice-over and exports
// MP4, WebM, a poster and captions into the app's public folder.
//
//   node src/video/render.ts src/video/tour.config.ts [--from=s] [--to=s] [--workers=n]
//
// --from and --to render part of the video for a quick look at one scene.

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const configArg = args.find(a => !a.startsWith('--'))
if (!configArg) {
  console.error('usage: node render.ts <config> [--from=s] [--to=s] [--workers=n]')
  process.exit(1)
}

const { configPath, config } = await importConfig(configArg)
const here = path.dirname(configPath)
const project = process.cwd()
const workDir = workDirFor(configPath, config)
const { fps, width, height } = config.output

function run(cmd: string, argv: string[]) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.error) throw new Error(`${cmd} is not installed, so the video cannot be built.`)
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim().slice(-2000)}`)
  return r.stdout
}
const ffmpeg = (argv: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...argv])
const duration = (file: string) =>
  Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]))
run('ffmpeg', ['-version'])
run('ffprobe', ['-version'])

type Timed = Beat & { start: number; end: number; voiceAt: number; voiceDur: number; voicePath?: string }

/** Lays the beats end to end: each lasts lead + voice + tail, or minSeconds if longer. */
function timeline(c: VideoConfig): Timed[] {
  let at = 0
  return c.beats.map(beat => {
    const voicePath = beat.voice ? path.resolve(here, beat.voice) : undefined
    if (voicePath && !existsSync(voicePath)) throw new Error(`Voice-over ${voicePath} does not exist.`)
    const voiceDur = voicePath ? duration(voicePath) : 0
    const lead = beat.lead ?? 0.2
    const dur = Math.max(beat.minSeconds ?? 0, lead + voiceDur + (beat.tail ?? 0.3))
    const timed = { ...beat, start: at, end: at + dur, voiceAt: at + lead, voiceDur, voicePath }
    at += dur
    return timed
  })
}

const beats = timeline(config)
const total = beats[beats.length - 1].end
const from = Number(flag('from') ?? 0)
const to = Math.min(total, Number(flag('to') ?? total))
if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from)
  throw new Error('Render range needs 0 <= --from < --to.')
const partial = from > 0 || to < total

const clips = Object.fromEntries(
  config.clips
    .filter(c => existsSync(path.join(workDir, 'clips', `${c.key}.json`)))
    .map(c => {
      const meta = JSON.parse(readFileSync(path.join(workDir, 'clips', `${c.key}.json`), 'utf8'))
      return [c.key, { src: `/clips/${c.key}.mp4`, ...meta }]
    })
)
const missing = config.clips.filter(c => !clips[c.key]).map(c => c.key)
if (missing.length) console.warn(`Not recorded yet, so those shots stay empty: ${missing.join(', ')}`)

// ── A static server for the project's composition, assets and clips ────────
// Chromium refuses ES modules from file:// pages, and seeking needs ranges.

const ROOTS: Record<string, string> = {
  compose: path.resolve(here, config.compose),
  ...(config.assets ? { assets: path.resolve(here, config.assets) } : {}),
  clips: path.join(workDir, 'clips')
}
if (!existsSync(path.join(ROOTS.compose, 'index.html')))
  throw new Error(`No composition found at ${ROOTS.compose}/index.html.`)
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4'
}
const server = createServer((req, res) => {
  const [, root, ...rest] = decodeURIComponent((req.url ?? '/').split('?')[0]).split('/')
  const base = ROOTS[root]
  const file = base && path.resolve(base, rest.join('/'))
  if (!file || !file.startsWith(base + path.sep) || !existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  const size = statSync(file).size
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    createReadStream(file).pipe(res)
    return
  }
  const start = range[1] ? Number(range[1]) : 0
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes'
  })
  createReadStream(file, { start, end }).pipe(res)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

// ── Frames ──────────────────────────────────────────────────────────────────

const out = path.join(workDir, 'render')
mkdirSync(out, { recursive: true })
const data = {
  fps,
  total,
  beats: Object.fromEntries(
    beats.map(b => [b.key, { start: b.start, end: b.end, voiceAt: b.voiceAt, voiceDur: b.voiceDur, narration: b.narration, clip: b.clip ?? b.key }])
  ),
  clips,
  output: { width, height }
}

const first = Math.round(from * fps)
const last = Math.round(to * fps)
const workers = Math.max(1, Number(flag('workers') ?? 3))
const chunk = Math.ceil((last - first) / workers)
// Screenshots are full-range sRGB; web video wants limited-range BT.709
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const SCALE = `scale=${width}:${height}:in_range=pc:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,format=yuv420p`

async function renderPart(index: number, startFrame: number, endFrame: number) {
  const file = path.join(out, `part-${index}.mp4`)
  const page = await Browser.launch({
    viewport: { width, height },
    pixelRatio: 1,
    profileDir: path.join(workDir, `render-profile-${index}`),
    port: 9400 + index
  })
  const encoder = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-vf',
      SCALE,
      '-c:v',
      'libx264',
      '-crf',
      '12',
      '-preset',
      'fast',
      ...COLOR,
      file
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
  const done = new Promise<void>((resolve, reject) =>
    encoder.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code} for part ${index}`))
    )
  )
  try {
    await page.goto(`${origin}/compose/index.html`, { settleMs: 300 })
    await page.waitFor('window.__setup', 20_000)
    await page.eval(`window.__setup(${JSON.stringify(data)})`)
    // A freshly loaded video can paint a stale frame on its first seek, so warm
    // every clip up on the frame before this part starts
    await page.eval(`window.__seek(${(Math.max(0, startFrame - 1) / fps).toFixed(5)})`)
    await page.eval(`window.__seek(${(startFrame / fps).toFixed(5)})`)
    for (let f = startFrame; f < endFrame; f++) {
      await page.eval(`window.__seek(${(f / fps).toFixed(5)})`)
      const shot = await page.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 94,
        optimizeForSpeed: true
      })
      if (!encoder.stdin.write(Buffer.from(shot.data, 'base64')))
        await new Promise(resolve => encoder.stdin.once('drain', resolve))
      if (index === 0 && (f - startFrame) % (fps * 5) === 0)
        console.log(`  ${(((f - startFrame) / (endFrame - startFrame)) * 100).toFixed(0)}% of part 0`)
    }
  } finally {
    encoder.stdin.end()
    await page.close()
  }
  await done
  return file
}

console.log(`Rendering ${((last - first) / fps).toFixed(1)}s of ${total.toFixed(1)}s with ${workers} workers`)
const t0 = Date.now()
const parts = await Promise.all(
  Array.from({ length: workers }, (_, i) => [first + i * chunk, Math.min(last, first + (i + 1) * chunk)] as const)
    .filter(([a, b]) => b > a)
    .map(([a, b], i) => renderPart(i, a, b))
)
server.close()
console.log(`Frames done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

const list = path.join(out, 'parts.txt')
writeFileSync(list, parts.map(p => `file '${path.basename(p)}'`).join('\n'))
const master = path.join(out, 'master.mp4')
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', master])

// ── Sound ───────────────────────────────────────────────────────────────────

/** Places each voice line at its beat, then levels the mix to -16 LUFS for the web. */
function mixAudio() {
  const voiced = beats.filter(b => b.voicePath)
  const inputs = ['-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo']
  const chains: string[] = []
  voiced.forEach((b, i) => {
    inputs.push('-i', b.voicePath!)
    const ms = Math.round(b.voiceAt * 1000)
    chains.push(`[${i + 1}]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`)
  })
  const labels = ['[0]', ...voiced.map((_, i) => `[v${i}]`)].join('')
  chains.push(
    `${labels}amix=inputs=${voiced.length + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,atrim=${from.toFixed(3)}:${to.toFixed(3)},asetpts=PTS-STARTPTS[a]`
  )
  const file = path.join(out, 'mix.wav')
  ffmpeg([...inputs, '-filter_complex', chains.join(';'), '-map', '[a]', '-ar', '48000', file])
  return file
}

const clock = (s: number) => {
  const ms = Math.round(s * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

/** One caption cue per sentence, spread over the voice line by length. */
function captions() {
  const cues: string[] = []
  for (const b of beats.filter(x => x.narration && x.voiceDur)) {
    const sentences = (b.narration.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [b.narration]).map(s => s.trim())
    const chars = sentences.reduce((sum, s) => sum + s.length, 0)
    let at = b.voiceAt
    for (const sentence of sentences) {
      const next = at + (b.voiceDur * sentence.length) / chars
      cues.push(`${clock(at)} --> ${clock(next)}\n${sentence}`)
      at = next
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** Writes under a temporary name, then swaps it in, so an open page never streams half a file. */
function publish(file: string, argv: string[]) {
  const temp = path.join(path.dirname(file), `.partial-${path.basename(file)}`)
  ffmpeg([...argv, temp])
  renameSync(temp, file)
  console.log(`${path.relative(project, file)}  ${(statSync(file).size / 1e6).toFixed(1)} MB`)
}

const audio = mixAudio()
const dest = partial ? out : path.resolve(here, config.output.dir)
mkdirSync(dest, { recursive: true })
const name = partial ? 'preview' : config.output.name
publish(path.join(dest, `${name}.mp4`), [
  '-i',
  master,
  '-i',
  audio,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-crf',
  '23',
  '-preset',
  'slow',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  ...COLOR,
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  '-shortest'
])
if (!partial) {
  publish(path.join(dest, `${name}.webm`), [
    '-i',
    master,
    '-i',
    audio,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '37',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-deadline',
    'good',
    '-cpu-used',
    '2',
    '-pix_fmt',
    'yuv420p',
    ...COLOR,
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-shortest'
  ])
  publish(path.join(dest, `${name}-poster.jpg`), [
    '-ss',
    String(config.output.posterAt),
    '-i',
    master,
    '-frames:v',
    '1',
    '-q:v',
    '2'
  ])
  writeFileSync(path.join(dest, `${name}.vtt`), captions())
  console.log(`${path.relative(project, path.join(dest, `${name}.vtt`))}`)
  writeFileSync(
    path.join(here, `${name}.timeline.json`),
    JSON.stringify(
      beats.map(({ key, start, end, voiceAt, voiceDur }) => ({ key, start, end, voiceAt, voiceDur })),
      null,
      2
    )
  )
}
console.log(`Done: ${total.toFixed(1)}s total`)
process.exit(0)
