import type { Browser } from './browser.ts'
import type { Stage } from './stage.ts'

// Types for the video config. The config imports them with `import type`, so
// they disappear at runtime.

export type Point = { x: number; y: number }
export type Viewport = { width: number; height: number }

/** A clip's actions: `s` drives the fake cursor, `page` the browser tab. */
export type Act = (s: Stage, page: Browser) => Promise<void>

/** One raw screen recording of the app. The compositor frames and times it. */
export type Clip = {
  /** Lowercase letters, digits and hyphens. Re-record one clip by its key. */
  key: string
  /** An app path, or a function that finds one, such as the demo site's editor. */
  path: string | ((page: Browser, baseUrl: string) => Promise<string>)
  cursor?: boolean
  act: Act
}

/**
 * One beat of the finished video. It lasts as long as its voice-over plus
 * `tail`, or `minSeconds`, whichever is longer. The compositor draws the beat
 * with the scene of the same key.
 */
export type Beat = {
  key: string
  /** Clip to show for this beat; defaults to a clip with the same key. */
  clip?: string
  /** Spoken text: the ElevenLabs script and the captions file. */
  narration: string
  /** Voice-over audio, relative to the config. */
  voice?: string
  minSeconds?: number
  /** Seconds after the voice ends before the next beat starts. */
  tail?: number
  /** Seconds into the beat before the voice starts. */
  lead?: number
}

export type Output = {
  /** Relative to the config file. */
  dir: string
  name: string
  width: number
  height: number
  fps: number
  /** Poster frame time, in seconds. */
  posterAt: number
}

export interface VideoConfig {
  /** The running app: local or staging, never production data. */
  baseUrl: string
  /** Composition folder containing index.html, relative to the config file. */
  compose: string
  /** Optional static assets served from /assets/, relative to the config file. */
  assets?: string
  /** Intermediate files, relative to the config file. Defaults to .video-cache. */
  workDir?: string
  /** Layout size in CSS pixels. */
  viewport: Viewport
  /** Render scale, for sharp text when the compositor zooms in. */
  pixelRatio: number
  output: Output
  /** Selectors to hide while recording. */
  hide: string[]
  /** Extra CSS injected into the app while recording. */
  css: string
  /** Anything matching this means the page is still loading. */
  busy: string
  /** Multiplier on cursor moves, scrolls and pauses. Lower is faster. */
  pace: number
  /** Runs after each page loads, before recording. */
  prepare?: (page: Browser) => Promise<void>
  /** Signs in once before recording, with the demo account. */
  signIn?: (context: { page: Browser; baseUrl: string }) => Promise<void>
  clips: Clip[]
  beats: Beat[]
}
