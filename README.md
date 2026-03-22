# Rollberry

Rollberry is an MIT-licensed open source CLI and Node API for turning web
pages into smooth top-to-bottom scroll videos. It can capture one or more
URLs into a single MP4, or render a project JSON file into multiple output
variants such as desktop and mobile. It is built for real browser capture,
works with normal URLs and `localhost`, and is published for direct `npx`
usage.

Maintained by CORe Inc.

## Quick Start

Requirements:

- Node.js `24.12.0+`
- `ffmpeg` available on `PATH`

Install nothing globally. Run it directly:

```bash
npx rollberry capture http://localhost:3000 \
  --out ./artifacts/demo.mp4 \
  --viewport 1440x900 \
  --fps 60 \
  --duration auto \
  --wait-for selector:body \
  --hide-selector '#cookie-banner'
```

On the first run, if Playwright Chromium is missing, Rollberry installs it
automatically. `ffmpeg` is not auto-installed.

For project-based rendering, start from the bundled sample:

```bash
cp rollberry.project.sample.json rollberry.project.json
npx rollberry render ./rollberry.project.json
```

## Using With npx

The normal way to run Rollberry is `npx`.

Use the latest published version:

```bash
npx rollberry capture http://localhost:3000 --out ./artifacts/demo.mp4
```

Pin a specific version:

```bash
npx rollberry@0.1.2 capture http://localhost:3000 --out ./artifacts/demo.mp4
```

Capture a local development server:

```bash
npx rollberry capture http://localhost:3000 \
  --out ./artifacts/local.mp4 \
  --wait-for selector:body
```

Capture a public page:

```bash
npx rollberry capture https://playwright.dev \
  --out ./artifacts/playwright.mp4 \
  --duration 8
```

Render a project file with multiple outputs:

```bash
npx rollberry render ./rollberry.project.json
```

Notes:

- `npx` downloads the published CLI package automatically
- on the first run, Rollberry installs Playwright Chromium if needed
- `ffmpeg` must already be available on your machine
- if you want reproducible automation, pin the package version with
  `npx rollberry@<version> ...`

## What You Get

Each run writes:

- `video.mp4`: the rendered capture
- `video.manifest.json`: environment, scene definitions, capture metrics, artifact metrics, and failure details
- `video.log.jsonl`: structured operational logs

You can override the sidecar paths with `--manifest` and `--log-file`.
Project renders write the same sidecars for each configured output, plus a
project-level `*.render-summary.json`.

## Common Examples

Capture a development site:

```bash
npx rollberry capture http://localhost:3000 --out ./artifacts/local.mp4
```

Capture a public site at a fixed duration:

```bash
npx rollberry capture https://playwright.dev \
  --out ./artifacts/playwright.mp4 \
  --duration 8 \
  --fps 60
```

Wait for a selector and hide overlays:

```bash
npx rollberry capture https://example.com \
  --wait-for selector:main \
  --hide-selector '#cookie-banner' \
  --hide-selector '.intercom-lightweight-app'
```

Capture multiple pages into a single video:

```bash
npx rollberry capture \
  https://example.com \
  https://example.com/about \
  https://example.com/contact \
  --out ./artifacts/multi-page.mp4
```

Add a pause between pages (the last frame of each page is held):

```bash
npx rollberry capture \
  https://example.com \
  https://example.com/about \
  --page-gap 1.5 \
  --out ./artifacts/with-gap.mp4
```

Dump raw frames for debugging:

```bash
npx rollberry capture http://localhost:3000 \
  --out ./artifacts/debug.mp4 \
  --debug-frames-dir ./artifacts/debug-frames
```

Render a project file into desktop and mobile outputs:

```bash
npx rollberry render ./rollberry.project.json
```

Render only one named output from a project:

```bash
npx rollberry render ./rollberry.project.json --output mobile
```

## Project Rendering

Use `render` when you want scene-by-scene control and multiple outputs from one
config file. `actions` run before capture as setup. `timeline` runs during the
capture itself and lets you interleave scroll, pause, and interactions inside
one scene.

```json
{
  "$schema": "./rollberry.project.schema.json",
  "schemaVersion": 1,
  "summaryManifest": "./artifacts/demo.render-summary.json",
  "defaults": {
    "fps": 60,
    "viewport": "1440x900",
    "waitFor": "selector:body",
    "hideSelectors": ["#cookie-banner"]
  },
  "scenes": [
    {
      "name": "home",
      "url": "http://localhost:3000",
      "actions": [
        { "type": "click", "selector": "[data-open-menu]" },
        { "type": "wait", "ms": 300 }
      ],
      "timeline": [
        { "type": "pause", "duration": 0.4 },
        {
          "type": "click",
          "selector": "[data-open-menu]",
          "holdAfterSeconds": 0.4
        },
        { "type": "scroll", "toSelector": "#pricing", "duration": 1.4 },
        { "type": "scroll", "to": "bottom", "duration": "auto" }
      ],
      "holdAfterSeconds": 0.75
    },
    {
      "name": "pricing",
      "url": "http://localhost:3000/pricing"
    }
  ],
  "outputs": [
    {
      "name": "desktop",
      "viewport": "1440x900",
      "out": "./artifacts/demo-desktop.mp4",
      "audio": {
        "path": "./assets/demo-narration.wav",
        "volume": 0.8,
        "loop": true
      },
      "subtitles": {
        "path": "./assets/demo-captions.vtt",
        "mode": "burn-in"
      },
      "transition": {
        "type": "crossfade",
        "duration": 0.25
      },
      "intermediateArtifact": {
        "format": "mp4",
        "preset": "veryfast",
        "crf": 20
      },
      "finalVideo": {
        "preset": "medium",
        "crf": 19
      }
    },
    {
      "name": "mobile",
      "viewport": "430x932",
      "out": "./artifacts/demo-mobile.webm",
      "format": "webm",
      "subtitles": {
        "path": "./assets/demo-captions.vtt",
        "mode": "soft"
      },
      "transition": {
        "type": "crossfade",
        "duration": 0.25
      },
      "intermediateArtifact": {
        "format": "mp4",
        "preset": "fast",
        "crf": 22
      },
      "finalVideo": {
        "deadline": "best",
        "crf": 30
      }
    }
  ]
}
```

Supported setup actions:

- `wait`
- `click`
- `hover`
- `press`
- `type`
- `scroll-to`

Supported timeline segments:

- `pause`
- `wait`
- `scroll`
- `click`
- `hover`
- `press`
- `type`
- `scroll-to`

Supported output extensions:

- `mp4`
- `webm`

Supported media extensions:

- output-level background audio via `audio.path`
- output-level subtitles via `subtitles.path`
- `subtitles.mode: "soft"` for `mp4` and `webm`
- `subtitles.mode: "burn-in"` for `mp4` and `webm`
- `.srt`, `.vtt`, and `.webvtt` subtitle inputs
- output-level `transition.type: "fade-in"`
- output-level `transition.type: "crossfade"` between adjacent scenes
- output-level `intermediateArtifact.format` / `preset` / `crf` for scene clip profiles
- output-level `finalVideo.preset` / `finalVideo.crf` for `mp4` encode control
- output-level `finalVideo.deadline` / `finalVideo.crf` for `webm` encode control
- project-level summary manifest via `summaryManifest`
- render manifest separates `captureMetrics` and `artifactMetrics`
- `crossfade` uses `ffprobe`-backed clip timing when available and fails fast if scene clip probing is unavailable

## CLI Options

```text
rollberry capture <url...>
rollberry render <project.json>

--out <file>                Output MP4 path
--viewport <WxH>            Viewport size, example: 1440x900
--fps <n>                   Frames per second
--duration <seconds|auto>   Explicit seconds or auto
--motion <curve>            ease-in-out-sine | linear
--timeout <ms>              Navigation timeout
--wait-for <mode>           load | selector:<css> | ms:<n>
--hide-selector <css>       Hide CSS selector before capture
--page-gap <seconds>        Pause between pages (default: 0)
--debug-frames-dir <dir>    Save raw PNG frames
--manifest <file>           Manifest JSON output path
--log-file <file>           Log JSONL output path

render:
--output <name>             Render only the named output (repeatable)
--force                     Overwrite configured output files
```

## Localhost Behavior

- Supports `http://localhost:*`, `https://localhost:*`,
  `http://127.0.0.1:*`, and `http://[::1]:*`
- Retries connection-refused errors until `--timeout`
- Accepts self-signed certificates for localhost targets only
- Does not start your dev server for you

## Troubleshooting

If `ffmpeg` is missing:

```bash
brew install ffmpeg
```

If you are running the test suite, `ffprobe` may also be used for extra video
verification. Most FFmpeg installs include it alongside `ffmpeg`.

If capture fails, inspect:

- `*.manifest.json` for final status and error details
- `*.log.jsonl` for per-step structured logs

If a site keeps shifting during capture:

- wait for a stable selector with `--wait-for selector:...`
- hide chat widgets, cookie banners, and sticky overlays with `--hide-selector`
- keep dynamic dev-only overlays out of the page when possible

## Support and Contact

- General contact: https://co-r-e.com/contact
- Security issues: see [SECURITY.md](./SECURITY.md)
- Contribution guide: see [CONTRIBUTING.md](./CONTRIBUTING.md)

## Local Development

For local CLI usage and captures, Rollberry requires `ffmpeg` on `PATH`.
When running `pnpm test`, the integration suite uses `ffprobe` when available
to inspect generated videos, but falls back to basic file validation if it is
missing.

```bash
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm check
corepack pnpm test
corepack pnpm build
```

Run from the repository:

```bash
corepack pnpm dev -- capture http://localhost:3000 --out ./artifacts/demo.mp4
corepack pnpm dev -- render ./rollberry.project.sample.json
```

Run the regression suite:

```bash
cp regression.sample.json regression.sites.json
corepack pnpm regression -- --config ./regression.sites.json
```

## Release Flow

Rollberry stays on the `v0.x.x` line for now.

1. Update `package.json` version and `CHANGELOG.md`
2. Commit the release prep
3. Create an annotated tag like `git tag -a v0.1.2 -m "Release v0.1.2"`
4. Push `main` and the tag to GitHub
5. GitHub Actions publishes to npm via trusted publishing

Trusted publishing setup expected by this repo:

- GitHub repository: `co-r-e/rollberry`
- Workflow filename: `.github/workflows/publish.yml`
- Trigger: push tag `v*`
- In npm package settings, add a trusted publisher that matches the repository
  and workflow above

## License

[MIT](./LICENSE)
