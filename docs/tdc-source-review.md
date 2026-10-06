# TDC video source review

This package was extracted from `src/video/` in TDC Site Builder. The reusable parts are the Chrome DevTools browser driver, scripted recording stage, MP4 encoder, renderer, screenshot helper, and flash checker.

The original `src/video/tour.config.ts` is a Blox-specific production script. It assumes a demo account, `/dashboard` and `/editor` paths, live AI generation, seeded records, a local domain provider, and named clip marks. It should stay with TDC and should run only against its disposable development environment. The original `src/video/compose/` scenes use Blox text, layout, fonts from `src/app/fonts`, artwork from `public/brand`, and the separately generated narration in `src/video/audio/`. Those are not general package assets.

`public/video/` contains the rendered Blox tour consumed by `ProductTourSection.tsx`. `public/videos/ai-site-generation.mp4` is a separate marketing clip consumed by `AiGenerationSection.tsx`; it is not an input to the tour generator. Neither output folder is bundled into this package.

The package replaces the TDC assumptions with a config relative composition folder, an optional asset folder, a per-project cache, a configurable output folder, and a starter composition. The new beat `clip` field maps narration beats to recorded clips for projects that do not use matching keys. Existing advanced compositions can still read clip marks and timing from `window.__setup(data)`.

To adapt the Blox tour to this package later, copy its config and composition into a TDC owned folder, set `compose` to that folder, set `assets` to a folder containing its fonts and brand image, update the composition asset URLs to `/assets/...`, and point `output.dir` at `public/video`. Keep the demo account setup and audio files within the TDC project. The current TDC scripts remain untouched by this standalone extraction.
