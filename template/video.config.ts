import type { VideoConfig } from 'project-video-kit'

export default {
  baseUrl: 'http://localhost:3000',
  compose: './compose',
  viewport: { width: 1280, height: 720 },
  pixelRatio: 1,
  output: {
    dir: '../public/video',
    name: 'product-tour',
    width: 1280,
    height: 720,
    fps: 30,
    posterAt: 1
  },
  hide: [],
  css: '',
  busy: '',
  pace: 1,
  clips: [
    {
      key: 'home',
      path: '/',
      async act(stage) {
        stage.mark('start')
        await stage.pause(800)
        await stage.scroll(400, 1600)
        await stage.pause(800)
      }
    }
  ],
  beats: [
    {
      key: 'intro',
      clip: 'home',
      narration: 'Welcome to our product.',
      minSeconds: 4
      // Add voice: './audio/intro.mp3' for narrated audio and timed captions.
    }
  ]
} satisfies VideoConfig
