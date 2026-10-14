# Project Video Kit

Record a running web app with a scripted cursor, then render a product video with optional narration, captions, MP4, WebM and a poster. The CLI runs in any web project; it does not depend on Next.js. This project has not been published to the npm registry. Pack it locally first with `npm pack`, or publish it under an available package name before using a registry install.

## Requirements

- Node.js 22.18 or newer
- Chrome, Chromium, Brave or Edge (`CHROMIUM_PATH` can point to the executable)
- `ffmpeg` and `ffprobe` on `PATH`
- A running local or staging web app for the recording step

## Install and create a video

```sh
npm install --save-dev /path/to/project-video-kit-0.1.0.tgz
npx project-video init
```

`init` creates `video/video.config.ts`, `video/compose/`, and a cache ignore file. Edit the config's `baseUrl`, `clips`, `beats`, and `output` for your app. Start your app, then run:

```sh
npx project-video record video/video.config.ts
npx project-video render video/video.config.ts
npx project-video check public/video/product-tour.mp4
```

The default config records your home page and creates a silent four-second example. Add `voice: './audio/intro.mp3'` to a beat to include narration and timed captions. The audio file is supplied by your project; the package does not call a speech service. The default composition shows app footage and beat text. Edit `video/compose/scenes.js` and `index.html` to change the look, motion, and timing. The renderer calls `window.__setup(data)` once and `window.__seek(seconds)` for every frame.

`output.dir`, `compose`, `assets`, `workDir`, and beat `voice` paths are relative to the config file. The default cache is `video/.video-cache/`, separate for each project. Full renders produce `.mp4`, `.webm`, `-poster.jpg`, `.vtt`, and a `.timeline.json` next to the config. Preview renders produce `video/.video-cache/render/preview.mp4`.

## Useful commands

```sh
npx project-video record video/video.config.ts home          # one clip
npx project-video snap video/video.config.ts /dashboard       # inspect the app
npx project-video render video/video.config.ts --from=2 --to=5 --workers=2
```

`Stage` provides `pause`, `move`, `click`, `clickText`, `type`, `scroll`, `find`, `locate`, and `mark`. `Browser` provides page navigation, selectors, input, cookies, and raw Chrome DevTools commands. Import `VideoConfig` for autocomplete; the generated config demonstrates the API. Each beat chooses a `clip` key and has optional `voice`, `lead`, `tail`, and `minSeconds` fields. Named `Stage.mark()` events are available as `data.clips[key].marks` in the composition.

Record only against an environment where the scripted actions are safe. A clip can click real controls and make real requests.

## Development

```sh
npm install
npm run build
npm test
npm pack --dry-run
```

The package is not published. Check that the npm name is available before publishing.
