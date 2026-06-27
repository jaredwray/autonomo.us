# @autonomo.us/logo

The animated **AUTONOMOUS** aurora logo — a dependency-free, framework-agnostic
SVG logo library. One animated mark, usable everywhere: as a string, a mounted
DOM node, or a custom element. The output always has a **transparent
background**.

## Highlights

- **Zero dependencies**, framework-agnostic (works with React, Vue, Svelte,
  plain HTML, SSR…).
- **Self-contained SVG** with scoped styles — animates as inline markup, an
  `<img>` source, or a CSS background.
- **Aurora animation**: the blades build top → bottom, a specular highlight
  sweeps left → right, then it settles into a seamless, forever idle (curtain
  sway, breathing, arrhythmic twinkle, slow hue drift).
- **Accessible & considerate**: `role="img"` with a label, and motion is
  automatically disabled for `prefers-reduced-motion`.
- Fully **configurable**: speed, size, palette, streak count, wordmark.

## Install

```bash
pnpm add @autonomo.us/logo
```

## Usage

### 1. Custom element (drop-in, any framework)

```html
<script type="module">
  import { defineAutonomousLogo } from "@autonomo.us/logo";
  defineAutonomousLogo();
</script>

<autonomous-logo animation="loop" speed="1.2" width="320"></autonomous-logo>
```

Attributes mirror the options below: `text`, `show-wordmark`, `width`,
`animation`, `speed`, `streaks`, `colors` (comma-separated), `wordmark-color`,
`tracking`, `font-family`, `title`, `reduced-motion`.

### 2. Imperative DOM mount

```ts
import { createLogo } from "@autonomo.us/logo";

const logo = createLogo("#brand", { animation: "loop", width: 320 });
logo.replay();              // restart the intro
logo.update({ speed: 2 });  // re-render with new options
logo.destroy();             // remove from the DOM
```

### 3. Static string (SSR / email / static sites)

```ts
import { renderToString } from "@autonomo.us/logo";

const svg = renderToString({ animation: "loop" });
```

### Plain `<script>` (no build step)

```html
<script src="https://unpkg.com/@autonomo.us/logo/dist/iife.iife.js"></script>
<autonomous-logo></autonomous-logo>
<div id="brand"></div>
<script>
  AutonomousLogo.createLogo("#brand", { width: 320 });
</script>
```

## Options

| Option                 | Type                          | Default        | Notes                                                        |
| ---------------------- | ----------------------------- | -------------- | ------------------------------------------------------------ |
| `text`                 | `string`                      | `"AUTONOMOUS"` | Wordmark text. Empty string renders the mark alone.          |
| `showWordmark`         | `boolean`                     | `true`         | Render the wordmark beneath the mark.                        |
| `width`                | `number`                      | _fills parent_ | Pixel width; height follows the aspect ratio.                |
| `animation`            | `"loop" \| "once" \| "none"`  | `"loop"`       | Idle forever, play once, or render the resting frame.        |
| `speed`                | `number`                      | `1`            | Global speed multiplier (`0.1`–`5`).                         |
| `streaks`              | `number`                      | `13`           | Number of aurora blades (`5`–`40`).                          |
| `colors`               | `string[]`                    | aurora ramp    | Gradient stops, top → bottom.                                |
| `wordmarkColor`        | `string`                      | `"#F4F7FF"`    | Wordmark fill.                                               |
| `tracking`             | `number`                      | `0.34`         | Wordmark letter-spacing, in `em`.                            |
| `fontFamily`           | `string`                      | thin sys sans  | Wordmark font stack.                                         |
| `respectReducedMotion` | `boolean`                     | `true`         | Disable motion under `prefers-reduced-motion`.              |

## Development

```bash
pnpm --filter @autonomo.us/logo dev    # live demo (Vite)
pnpm --filter @autonomo.us/logo build  # esm + cjs + d.ts + iife
pnpm --filter @autonomo.us/logo test   # vitest + coverage
```

## License

MIT
