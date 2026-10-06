import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type Browser, sleep } from './browser.ts'
import type { Point, Viewport } from './types.ts'

// Recording helpers that live inside the page: a fake cursor, a frame
// recorder and named marks. Title cards, captions and motion graphics are
// drawn later by the compositor, so nothing here covers the app.

export type StageOptions = {
  hide: string[]
  css: string
  pace: number
  pixelRatio: number
  viewport: Viewport
}

type Frame = { sessionId: number; data: string; metadata: { timestamp: number } }

const stageScript = (hide: string[], extraCss: string) => {
  const css = `
    ${hide.length ? `${hide.join(', ')} { display: none !important; }` : ''}
    html { scroll-behavior: auto !important; }
    *::-webkit-scrollbar { display: none; }
    #__pv_cursor { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none;
      transform: translate(-100px, -100px); filter: drop-shadow(0 3px 4px rgba(43,38,33,.4)); }
    #__pv_cursor .ring { position: absolute; left: -16px; top: -16px; width: 32px; height: 32px;
      border-radius: 999px; background: #c9a385; opacity: 0; transform: scale(0); }
    #__pv_cursor.click .ring { animation: __pv_ring .5s ease-out; }
    #__pv_cursor.click svg { animation: __pv_press .22s ease-out; }
    @keyframes __pv_ring { 0% { transform: scale(.3); opacity: .7 } 100% { transform: scale(1.8); opacity: 0 } }
    @keyframes __pv_press { 50% { transform: scale(.82) } }
    ${extraCss}
  `
  return `(() => {
    if (window.__pv) return true;
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "__pv_cursor";
    cursor.innerHTML = '<div class="ring"></div><svg width="30" height="30" viewBox="0 0 26 26"><path d="M4 2.5v19.2l5.1-4.9 3.3 7.5 3.4-1.5-3.3-7.4h7.1z" fill="#2b2621" stroke="#f7f3ec" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    // A 1px element that repaints every frame, so frames keep coming when nothing moves
    const tick = document.createElement("div");
    tick.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;z-index:2147483647;pointer-events:none";
    document.body.append(cursor, tick);
    let i = 0;
    (function paint() { tick.style.background = i++ % 2 ? "#000" : "#010101"; requestAnimationFrame(paint); })();
    window.__pv = { cursor, x: -100, y: -100 };
    return true;
  })()`
}

/** Scene helpers for one browser tab, plus a frame recorder. */
export class Stage {
  page: Browser
  options: StageOptions
  #frames: Array<{ file: string; ts: number }> = []
  #marks: Record<string, number> = {}
  #dir = ''
  #recording = false
  #skipFirst = false
  #writes: Promise<void>[] = []

  constructor(page: Browser, options: StageOptions) {
    this.page = page
    this.options = options
    page.on('Page.screencastFrame', (frame: Frame) => {
      page.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      if (!this.#recording) return
      // The first frame can be a stale paint from before recording started
      if (this.#skipFirst) {
        this.#skipFirst = false
        return
      }
      const file = path.join(this.#dir, `${String(this.#frames.length).padStart(6, '0')}.jpg`)
      this.#frames.push({ file, ts: frame.metadata.timestamp })
      this.#writes.push(writeFile(file, Buffer.from(frame.data, 'base64')))
    })
  }

  /** Adds the cursor and recording styles to the current page. */
  async inject({ cursor = true }: { cursor?: boolean } = {}) {
    await this.page.eval(stageScript(this.options.hide, this.options.css))
    if (!cursor) await this.page.eval(`__pv.cursor.style.display = "none"`)
  }

  /** Starts saving painted frames into `dir`. */
  async record(dir: string) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    this.#dir = dir
    this.#frames = []
    this.#writes = []
    this.#marks = {}
    await this.page.eval('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))')
    this.#skipFirst = true
    this.#recording = true
    const { width, height } = this.options.viewport
    await this.page.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: width * this.options.pixelRatio,
      maxHeight: height * this.options.pixelRatio,
      everyNthFrame: 1
    })
  }

  /**
   * Notes a named moment, such as "typed" or "built". The compositor reads
   * marks to time its zooms, callouts and speed ramps against the footage.
   */
  mark(name: string) {
    this.#marks[name] = Date.now() / 1000
  }

  /**
   * Stops recording and writes an ffmpeg concat list in which each frame
   * lasts until the next one arrived. Returns the clip length and marks in
   * seconds from the first frame.
   */
  async stop() {
    await sleep(120)
    this.#recording = false
    await this.page.send('Page.stopScreencast')
    await sleep(200)
    await Promise.all(this.#writes)
    const frames = this.#frames
    if (!frames.length) throw new Error('No frames were captured, so this clip is empty.')
    const lines = frames.flatMap((f, i) => {
      const next = frames[i + 1]
      const duration = next ? Math.max(next.ts - f.ts, 0.001) : 1 / 30
      return [`file '${path.basename(f.file)}'`, `duration ${duration.toFixed(4)}`]
    })
    lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`)
    writeFileSync(path.join(this.#dir, 'list.txt'), lines.join('\n'))
    const first = frames[0].ts
    const marks = Object.fromEntries(Object.entries(this.#marks).map(([name, t]) => [name, Math.max(0, t - first)]))
    return { seconds: frames[frames.length - 1].ts - first, marks }
  }

  /** Waits, scaled by the configured pace. */
  pause(ms: number) {
    return sleep(ms * this.options.pace)
  }

  /** Glides the cursor to a point, sending real mouse moves so hover states show. */
  async move(x: number, y: number, ms = 700) {
    ms *= this.options.pace
    const from = await this.page.eval<Point>('({ x: __pv.x, y: __pv.y })')
    // The first move of a scene starts just off to the lower right
    const start = from.x < 0 ? { x: x + 180, y: y + 140 } : from
    const steps = Math.max(8, Math.round(ms / 16))
    const t0 = performance.now()
    for (let i = 1; i <= steps; i++) {
      const p = i / steps
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
      // A slight arc looks more like a hand than a straight line
      const cx = start.x + (x - start.x) * e + Math.sin(Math.PI * e) * (y - start.y) * 0.06
      const cy = start.y + (y - start.y) * e - Math.sin(Math.PI * e) * (x - start.x) * 0.06
      await this.page.eval(
        `__pv.x=${cx};__pv.y=${cy};__pv.cursor.style.transform="translate(${cx - 4}px, ${cy - 2}px)";true`
      )
      if (i % 2 === 0 || i === steps) await this.page.mouse('mouseMoved', cx, cy)
      const wait = t0 + (ms * i) / steps - performance.now()
      if (wait > 0) await sleep(wait)
    }
  }

  /** Clicks where the cursor is, or moves there first. */
  async click(x?: number, y?: number) {
    if (x !== undefined && y !== undefined) await this.move(x, y)
    const pos = await this.page.eval<Point>('({ x: __pv.x, y: __pv.y })')
    await this.page.eval(
      `(() => { const c = __pv.cursor; c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); return true; })()`
    )
    await this.page.mouse('mousePressed', pos.x, pos.y)
    await sleep(70)
    await this.page.mouse('mouseReleased', pos.x, pos.y)
  }

  /** Moves to the element whose text starts with `text` and clicks it. */
  async clickText(text: string, ms = 700) {
    const p = await this.find(text)
    await this.move(p.x, p.y, ms)
    await this.click()
  }

  /** Types into the focused field one character at a time, with a human rhythm. */
  async type(text: string, charsPerSecond = 28) {
    for (const ch of text) {
      await this.page.send('Input.insertText', { text: ch })
      const base = 1000 / charsPerSecond
      await sleep(ch === ' ' ? base * 1.6 : ch === '.' || ch === ',' ? base * 3 : base * (0.6 + Math.random() * 0.8))
    }
  }

  /**
   * Smoothly scrolls by `dy` CSS pixels. Scrolls the page, or the element
   * matching `container` for apps that scroll inside a panel.
   */
  async scroll(dy: number, ms = 1400, container?: string) {
    ms *= this.options.pace
    await this.page.eval(`new Promise(done => {
      const el = ${container ? `document.querySelector(${JSON.stringify(container)})` : 'document.scrollingElement'};
      const from = el.scrollTop;
      const to = Math.max(0, Math.min(from + ${dy}, el.scrollHeight - el.clientHeight));
      const t0 = performance.now();
      const ease = p => p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
      (function step(now) {
        const p = Math.min(1, (now - t0) / ${ms});
        el.scrollTop = from + (to - from) * ease(p);
        p < 1 ? requestAnimationFrame(step) : done(true);
      })(t0);
    })`)
  }

  /**
   * Viewport position of the smallest visible element whose text starts with
   * `text`, so scenes point at things without fixed coordinates.
   */
  async find(text: string, within = 'body') {
    const point = await this.page.eval<Point | null>(`(() => {
      const t = ${JSON.stringify(text)};
      const starts = e => (e.textContent || "").trim().startsWith(t);
      const root = document.querySelector(${JSON.stringify(within)}) ?? document.body;
      const el = [...root.querySelectorAll("*")].find(e => {
        if (e.closest("#__pv_cursor")) return false;
        const b = e.getBoundingClientRect();
        return starts(e) && b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && ![...e.children].some(starts);
      });
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2 };
    })()`)
    if (!point) throw new Error(`The text "${text}" is not visible on the page.`)
    return point
  }

  /** Viewport center of the first element matching a CSS selector. */
  async locate(selector: string) {
    const point = await this.page.eval<Point | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`)
    if (!point) throw new Error(`No element matches ${selector}.`)
    return point
  }
}
