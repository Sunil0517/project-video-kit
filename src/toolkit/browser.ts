import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Point, VideoConfig, Viewport } from './types.ts'

// A minimal Chrome DevTools Protocol driver for a headless Chromium browser.
// No dependencies: it needs Node 22.18+ (type stripping, fetch, WebSocket) or Bun.

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))

const LINUX = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'brave',
  'brave-browser',
  'microsoft-edge'
]
const MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]
const WINDOWS = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Chromium', 'Application', 'chrome.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ['Microsoft', 'Edge', 'Application', 'msedge.exe']
]

const onPath = (command: string) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .map(dir => path.join(dir, command))
    .find(file => existsSync(file))

/** Path to a Chromium-based browser: CHROMIUM_PATH, then common installs. */
export function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  if (process.platform === 'darwin') return MAC.find(file => existsSync(file))
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root)
    )
    for (const parts of WINDOWS)
      for (const root of roots) {
        const file = path.join(root, ...parts)
        if (existsSync(file)) return file
      }
    return undefined
  }
  for (const command of LINUX) {
    const file = onPath(command)
    if (file) return file
  }
  return undefined
}

/** Loads a video config and returns its default export. */
export async function importConfig(file: string) {
  const configPath = path.resolve(file)
  if (!existsSync(configPath)) throw new Error(`No config file at ${configPath}.`)
  const mod = await import(pathToFileURL(configPath).href)
  const config = (mod.default ?? mod) as VideoConfig
  if (!config.baseUrl || !config.compose || !config.output || !config.viewport)
    throw new Error('Config needs baseUrl, compose, viewport and output.')
  if (!Array.isArray(config.clips) || !Array.isArray(config.beats) || !config.beats.length)
    throw new Error('Config needs clips and at least one beat.')
  if (![config.viewport.width, config.viewport.height, config.pixelRatio, config.output.width,
    config.output.height, config.output.fps].every(n => Number.isFinite(n) && n > 0))
    throw new Error('Viewport, pixel ratio, output size and fps must be positive numbers.')
  const validKey = (key: string) => /^[a-z0-9][a-z0-9-]*$/.test(key)
  for (const entry of [...config.clips, ...config.beats])
    if (!validKey(entry.key)) throw new Error(`Invalid clip or beat key: ${entry.key}`)
  if (new Set(config.clips.map(c => c.key)).size !== config.clips.length ||
      new Set(config.beats.map(b => b.key)).size !== config.beats.length)
    throw new Error('Clip and beat keys must each be unique.')
  return { configPath, config }
}

/** Keep each project's intermediate files separate. */
export const workDirFor = (configPath: string, config: VideoConfig) =>
  path.resolve(path.dirname(configPath), config.workDir ?? '.video-cache')

type Handler = (params: any) => void
type Pending = { method: string; resolve: (result: any) => void; reject: (error: Error) => void }

export class Browser {
  #ws: WebSocket
  #proc: ChildProcess
  #seq = 0
  #pending = new Map<number, Pending>()
  #handlers = new Map<string, Handler[]>()
  #closed = false

  constructor(proc: ChildProcess, ws: WebSocket) {
    this.#proc = proc
    this.#ws = ws
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data))
      if (msg.id) {
        const pending = this.#pending.get(msg.id)
        this.#pending.delete(msg.id)
        if (msg.error) pending?.reject(new Error(msg.error.message))
        else pending?.resolve(msg.result)
      } else if (msg.method) {
        for (const handler of this.#handlers.get(msg.method) ?? []) handler(msg.params)
      }
    })
    // A crashed or closed browser fails every waiting command instead of hanging
    ws.addEventListener('close', () => {
      this.#closed = true
      for (const pending of this.#pending.values()) pending.reject(this.#closedError(pending.method))
      this.#pending.clear()
    })
  }

  #closedError(method: string) {
    return new Error(`The browser closed before ${method} finished, so recording stopped. Run the command again.`)
  }

  /**
   * Starts a headless browser that lays pages out at `viewport` CSS pixels
   * and renders them at `pixelRatio`, then attaches to its tab.
   */
  static async launch({
    viewport,
    pixelRatio,
    profileDir,
    port = 9333
  }: {
    viewport: Viewport
    pixelRatio: number
    profileDir?: string
    port?: number
  }) {
    const executable = findChromium()
    if (!executable) throw new Error('No Chrome, Chromium, Brave or Edge found. Install one or set CHROMIUM_PATH.')
    const proc = spawn(
      executable,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir ?? path.join(os.tmpdir(), 'product-video-profile')}`,
        `--window-size=${viewport.width},${viewport.height}`,
        // Without this, screencast frames arrive at 1x even with emulation
        `--force-device-scale-factor=${pixelRatio}`,
        '--hide-scrollbars',
        '--font-render-hinting=none',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ],
      { stdio: 'ignore' }
    )

    let url: string | undefined
    for (let i = 0; i < 100 && !url; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
        url = targets.find(t => t.type === 'page')?.webSocketDebuggerUrl
      } catch {
        // The browser is still starting
      }
      if (!url) await sleep(100)
    }
    if (!url) {
      proc.kill()
      throw new Error(
        `The browser did not open its debugging port ${port}. Close other browsers using that port or pass another.`
      )
    }

    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const browser = new Browser(proc, ws)
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      deviceScaleFactor: pixelRatio,
      mobile: false
    })
    return browser
  }

  /** Sends a raw DevTools Protocol command and resolves with its result. */
  send<T = any>(method: string, params: object = {}): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError(method))
    const id = ++this.#seq
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { method, resolve, reject }))
  }

  on(event: string, handler: Handler) {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler])
  }

  off(event: string) {
    this.#handlers.delete(event)
  }

  /** Emulates `prefers-color-scheme` for sites that follow the system theme. */
  async colorScheme(value: 'light' | 'dark') {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }]
    })
  }

  /** Runs a JavaScript expression in the page and returns its value. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /**
   * Opens a URL and waits until it loaded, no element matches `busy`
   * (spinners, skeletons) and fonts are ready.
   */
  async goto(url: string, { busy, settleMs = 900 }: { busy?: string; settleMs?: number } = {}) {
    const loaded = new Promise(resolve => this.on('Page.loadEventFired', resolve))
    await this.send('Page.navigate', { url })
    await Promise.race([loaded, sleep(30_000)])
    this.off('Page.loadEventFired')
    const busyCheck = busy ? `!document.querySelector(${JSON.stringify(busy)})` : 'true'
    for (let i = 0; i < 130; i++) {
      const ready = await this.eval<boolean>(`document.readyState === "complete" && ${busyCheck}`).catch(error => {
        if (this.#closed) throw error
        return false
      })
      if (ready) break
      await sleep(150)
    }
    await this.eval('document.fonts.ready.then(() => true)').catch(() => {})
    await sleep(settleMs)
  }

  /**
   * Polls a JavaScript expression until it is truthy, such as a URL change
   * after signing in. Fails after `timeoutMs`.
   */
  async waitFor(expression: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Evaluation fails while a navigation replaces the page; keep polling
      const done = await this.eval<boolean>(`Boolean(${expression})`).catch(error => {
        if (this.#closed) throw error
        return false
      })
      if (done) return
      await sleep(100)
    }
    throw new Error(
      `The page never matched ${expression} within ${timeoutMs / 1000}s, so the next step would run too early. Check the step before it.`
    )
  }

  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1
    })
  }

  /** Clicks the first element matching a CSS selector, without the fake cursor. */
  async click(selector: string) {
    const point = await this.eval<Point | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`)
    if (!point) throw new Error(`No element matches ${selector}.`)
    await this.mouse('mousePressed', point.x, point.y)
    await this.mouse('mouseReleased', point.x, point.y)
  }

  /** Focuses a field and types text into it, as a person would. */
  async fill(selector: string, text: string) {
    const found = await this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.select?.();
      return true;
    })()`)
    if (!found) throw new Error(`No field matches ${selector}.`)
    await this.send('Input.insertText', { text })
  }

  /** Presses one key, such as Enter or Tab, in the focused element. */
  async press(key: string) {
    for (const type of ['keyDown', 'keyUp'])
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        // Text on keyDown also sends keypress, which submits forms on Enter
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
        windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : 0
      })
  }

  /** Sets cookies, for example a session cookie your app issued. */
  async setCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>) {
    await this.send('Network.setCookies', { cookies })
  }

  async close() {
    await this.send('Browser.close').catch(() => {})
    this.#proc.kill()
  }
}
