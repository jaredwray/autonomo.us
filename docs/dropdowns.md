# Dropdown component choice

The supplied screenshot shows the Dashboard Overview Period field in dark mode,
with the chevron near the right edge and adjacent text cropped. It does not show
an open menu. The previous implementation used native selects plus experimental
`appearance: base-select` rules, so popup styling depended on browser support.

The application uses React 19, Vite, plain CSS tokens, and no existing component
kit. This change adopts Base UI 1.9's Select, imported from its component subpath,
for all 38 single-select declarations. Searchable model/mention inputs and
navigation/action menus have different semantics and retain their existing UI.

| Option | Accessibility and keyboard | Styling and fit | Bundle tradeoff |
| --- | --- | --- | --- |
| Native select | Platform keyboard, focus, validation and mobile picker | No dependency, but popup appearance remains browser-dependent | No library cost; does not address consistent popup styling |
| Base UI Select (chosen) | Managed listbox focus, arrows, Home/End, typeahead, disabled items, Escape, form integration | Unstyled; existing CSS tokens; empty-string values remain real choices; positioned portal avoids clipping | Tree-shaken component import; measured app increase below |
| Radix Select | Managed focus, keyboard navigation, typeahead, positioning | Unstyled and a good React fit; empty-string choices need an adapter because an empty value represents a placeholder | Component dependency is possible; published component sizes are not directly comparable to app deltas |
| Headless UI Listbox | Managed listbox focus, keyboard and disabled choices | Unstyled; supports anchored portals; requires separate consideration of native required-field validation | Tree-shaken React package; no measured app delta in this evaluation |

All three libraries have current documentation and maintained release streams.
Base UI best matches this app's frequent empty choices (All models, All callers,
Choose a member) and form needs without sentinel values or a second form-control
implementation. No styled theme or CSS framework is introduced.

Sources checked November 16, 2026:
- https://base-ui.com/react/components/select
- https://base-ui.com/react/overview/releases
- https://www.radix-ui.com/primitives/docs/components/select
- https://headlessui.com/react/listbox

## Integration

`Dropdown` accepts controlled string/number values and string value callbacks.
Existing option declarations stay beside their business rules; conditional and
array options are flattened into Base UI items. Labels, unavailable values,
disabled choices, required fields, focus refs, and dependent-field resets remain.
The adapter intentionally supports flat, text-only, single-select options, which
are the current call sites; it is not a general native-select replacement.

Popups use a portal, available-viewport bounds, scrolling and wrapping for long
labels. Triggers truncate long values and reserve space for the chevron. Both
use existing light/dark tokens. Targets are at least 44px tall. Base UI owns the
keyboard interaction; navigation alone does not run business callbacks. Escape
cancels and returns focus. Tab closes and moves onward rather than committing a
highlighted, unconfirmed value (important for access/role selectors).

## Size

Same Vite version and dependencies, compared with main `174e666`:

| Production asset | Main | With dropdown kit |
| --- | ---: | ---: |
| JavaScript minified | 535.37 kB | 650.94 kB |
| JavaScript gzip | 148.72 kB | 189.29 kB |
| CSS gzip | 14.62 kB | 14.65 kB |

The roughly 40.6 kB gzip increase is a real cost. Both builds already exceed
Vite's 500 kB chunk warning threshold. Route splitting is separate work.

## Verification

- UI integration tests choose visible options rather than dispatching synthetic
  native-select change events; existing business outcomes remain asserted.
- Dedicated interaction tests cover keyboard focus, disabled choices and controls,
  Escape, and returning to empty-string values.
- `pnpm --filter @autonomo.us/ux test:browser` runs the real Dashboard filter layout
  and a synthetic required-form fixture at 320, 550 and 1280px in light/dark modes.
  Browser tests cover selection, typeahead, focus, Tab, validation and popup bounds.
- The fixture intercepts all API requests; no credentials or live data are needed.
- Local desktop Chromium is blocked by a process-socket restriction. The hosted
  browser job uses the runner's installed Chrome; report its result separately.
- Screen-reader and real iOS/Android device testing remain manual follow-up.
