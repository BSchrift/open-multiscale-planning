# Design system

Multiscale is opened many times a day for a two-second glance, mostly in dark mode on a desktop, and on an iPhone in
between. This page is the design every screen draws from: the principles, the tokens in
[`tokens.css`](../frontend/src/ui/styles/tokens.css), the calendar block's states, the icons and the shared components.
Tokens and components change here first, in the same pull request as the code.

## Principles

1. **Now, then next, then the rest.** The strongest contrast on a screen goes to what's happening now and the one
   thing to do next. The past recedes, and detail waits behind a tap.
2. **One loud thing per view.** A surface has at most one filled button. Secondary actions are outlined at 3:1 so they
   still read as buttons; tertiary actions are text. Two filled buttons never compete in one card or sheet.
3. **Colour says what kind; shape, icon and word say what state.** Hue is kept for the kind of work: blue projects,
   teal practices, purple one offs, and orange for the block being placed. Done, Partly, Not done, gone by and in
   progress are carried by fill, outline, strike, icon and a word, so they survive colour blindness, dark mode and
   greyscale.
4. **The same thing looks the same everywhere.** A component has one design, changed per layout only where the
   platform needs it: a bottom sheet on phone and a dialog on desktop, 44pt targets on phone, hover on desktop.
5. **Calm by subtraction.** Few greys, few sizes, few lines. Hairlines and space separate things before boxes do, and
   nothing moves unless it explains a change.

## Colour

Twenty-seven roles, with the same names in light and dark. A role is a job, not a shade: pick by what the thing is,
never by how it looks, and never add a colour for one screen.

| Role | Light | Dark | For |
| --- | --- | --- | --- |
| `--ground` | `#efefea` | `#0d0e10` | The page. Page titles and section labels sit on it. |
| `--card` | `#fff` | `#1d1f22` | Section cards and list groups. |
| `--raised` | `#fff` | `#2a2c30` | Dialogs, sheets, popovers and the tab bar. In dark, a step above the card. |
| `--ink` | `#1e2126` | `#e4e5e1` | Main text, and the toast's surface. |
| `--ink-2` | `#3d424a` | `#c3c6c9` | Secondary text and icons. |
| `--ink-3` | `#5e646e` | `#9a9fa6` | Meta text, hour labels and chevrons. |
| `--line` | `#85877f` | `#787d84` | Control boundaries at 3:1: fields, checkboxes, outlined buttons, the slider's track. |
| `--accent` | `#1f5f8b` | `#72b3e3` | The one filled button. |
| `--on-accent` | `#fff` | `#1d1f22` | Text and icons on the accent. |
| `--accent-text` | `#1f5f8b` | `#72b3e3` | Links, quiet buttons and selected labels. |
| `--accent-tint` | `#e8f0f6` | `#1b2d3c` | A selected pill, a toggle that's on, the chosen answer. |
| `--focus` | `#1f5f8b` | `#72b3e3` | The focus ring. |
| `--project`, `--practice`, `--oneoff` | | | A kind's edge, dot and solid fill. |
| `--project-tint`, `--practice-tint`, `--oneoff-tint` | | | A kind's block fill. |
| `--project-ink`, `--practice-ink`, `--oneoff-ink` | | | Text on a kind's tint. |
| `--on-kind` | `#fff` | `#1d1f22` | Text on a solid kind fill. |
| `--placing` | `#c2410c` | `#f5944d` | The block being placed, whatever its kind. |
| `--danger` | `#b3261e` | `#f08a80` | Overdue, Past end date, Delete. |
| `--warn` | `#8a5300` | `#e0a040` | Behind, No tasks. Never Not done. |
| `--ok` | `#1e6b3e` | `#6fcf97` | On track. |
| `--ink-action` | `#bfe0f5` | `#1f5f8b` | Undo, and the focus ring, on the toast. |

**Derived colours** are made from the roles and never chosen on their own; `tokens.test.ts` checks each against its
recipe. Most are a colour at a strength, written as eight hex digits, so they read the same on any surface.

| Token | Recipe | For |
| --- | --- | --- |
| `--hairline` | ink at 11% | Dividers, card outlines, grid lines. |
| `--wash` | ink at 7% | Quiet fills and hover; done blocks; tracks. |
| `--pressed` | ink at 13% | A pressed control; the second stripe of another calendar's event. |
| `--accent-hover` | the accent with 18% ink | A hovered primary. |
| `--danger-tint`, `--warn-tint`, `--ok-tint` | the tone at 14% | Status pills. |
| `--placing-tint` | placing at 16% | The block being placed. |

**Contrast** is computed from the tokens in both themes by `tokens.test.ts`: text at 4.5:1 on what it sits on, and
icons that carry meaning, focus rings, control boundaries, kind edges, bars and meters at 3:1. A new pairing goes into
its list in the same change.

## Type

One family, Instrument Sans, self-hosted. Seven text styles at two weights, 400 (`--fw-regular`) and 600
(`--fw-strong`). Each style is a size and a line height: `--fs-<style>` and `--lh-<style>`.

| Style | Desktop | Phone | Apple text style | For |
| --- | --- | --- | --- | --- |
| Display | 40 / 44 | 40 / 44 | Scales with the others | The clock and free-time totals, with tabular numerals. |
| Title | 24 / 30 | 28 / 34 | Title 1 | Page titles. |
| Heading | 17 / 24 | 17 / 24 | Headline | Card titles, the Now card's title. |
| Body | 15 / 22 | 17 / 24 | Body | Rows and descriptions. |
| Label | 14 / 20 | 16 / 22 | Callout | Buttons, chips and fields. |
| Meta | 13 / 18 | 15 / 20 | Subheadline | Times, estimates and meta lines. |
| Caption | 12 / 16 | 12 / 16 | Caption 1 | Eyebrows, hour labels and keycaps. Nothing is smaller. |

Phone sizes are set under `[data-layout='phone']`. In the iPhone app they're in points that follow the phone's text-size
setting: the root takes Body's size from the phone (`font: -apple-system-body`, 17pt at the default setting) and every
style keeps its ratio to it, so at the default each matches its Apple text style. Layouts must survive text at 200%.

## Space, shape and depth

- **Spacing:** eight steps on a 4px grid, named by their multiple of 4: `--space-1` (4px), `-2` (8), `-3` (12), `-4`
  (16), `-6` (24), `-8` (32), `-12` (48), `-16` (64). A hairline nudge of 1px is the only raw value allowed.
- **Radii by role:** `--radius-block` (6px: blocks and chips), `--radius-control` (8px: buttons and fields),
  `--radius-card` (12px desktop, 14px phone), `--radius-sheet` (16px), `--radius-pill`, `--radius-circle`.
- **Borders:** `--border-hairline` (1px), `--border-emphasis` (2px: a selected or in-progress frame) and `--edge`
  (4px: a block's kind edge).
- **Elevation:** `--shadow-1` for cards, `--shadow-2` for popovers, corner cards, floating buttons and the tab bar,
  `--shadow-3` for dialogs and sheets, and `--scrim` behind them. A ring drawn as a shadow (`0 0 0 2px var(--focus)`)
  or an inset edge (`inset 3px 0 0 var(--oneoff)`) is a border, not a shadow, and takes a colour token.
- **Sizes:** `--tap` (44px, every phone target and desktop primary), `--tap-compact` (36px, desktop only), icons at
  `--icon-sm` (16px), `--icon-md` (20px) and `--icon-lg` (24px) on one stroke, `--icon-stroke` (1.75).
- **Layers, lowest first:** `--z-raised` (a lift within a component), `--z-sticky`, `--z-nav`, `--z-overlay` (scrims
  and sheets), `--z-dialog`, `--z-toast`.
- **Motion:** `--dur-fast` (120ms: hover and press), `--dur-medium` (200ms: things that appear), `--dur-slow` (250ms:
  sheets), on one curve, `--ease`. With `prefers-reduced-motion`, fades only.

## Focus

One 2px ring in `--focus` at a 2px offset on everything focusable, at 3:1 against both the control and what's behind
it. On ink surfaces such as the toast it's `--ink-action`; inside a container that clips, it's inset (`outline-offset:
-2px`).

## Calendar blocks

One block for every calendar, phone and desktop. The kind sets the colour; the state sets the shape, the icon and the
word. Answer badges are round, in ink rather than the kind's colour: 16px on Today and Week, 12px on a 15-minute block.

| State | Looks like |
| --- | --- |
| Planned | The kind's tint, with its edge on the leading side: solid for a project, double for a practice, dotted for a one off. |
| In progress | A 2px ink frame, a live dot and the word Now, on every kind. Never the project blue. |
| Done | The fill drops to the card with a hairline, the title is struck through, and a filled tick badge. |
| Partly | Half filled with the kind's tint, showing how much got done, a half-circle badge and the word Partly. |
| Not done | The card with a hairline, a cross-in-a-ring badge and the words Not done. Never struck, never amber. |
| Gone by, no answer yet | A dashed outline and a dashed-ring badge. |
| Being placed | The placing tint with a 2px placing frame, lifted with `--shadow-2`. |
| Drop target | A 2px dashed accent outline over a faint accent wash. |
| Suggested | No fill, a dashed outline in the kind's colour. |
| Planning | A wash with an ink-3 edge. |
| Inbox, not yet sorted | Planning's wash with a dashed ink-3 edge, the inbox icon and the word Inbox. Once Process files it, it takes its kind's look. |
| Another calendar's event | Grey stripes with a line-coloured edge. |
| Information only | No fill, a dashed line-coloured outline. |

Only Done is ever struck through. The current-time line passes behind blocks, with only its dot in front.

## Icons

One SVG set on a 24px grid, stroked in `currentColor` at `--icon-stroke` with round caps and joins, drawn at 16, 20 or
24px in a fixed slot so icons line up with each other and with text. Filled only where a state needs it: the selected
tab, the live dot, the Done badge. No text glyph is ever an icon: not ›, ‹, ▾, ▸, ✓, × or ✕. An icon-only button is
named in full for screen readers.

## Components

The shared components live in `frontend/src/ui/components/ds`. Use them rather than building the same thing again.

- **`Icon`**: `<Icon name="chevron-right" size={16} />`, at 16, 20 (the default) or 24. The set: the answers (`done`,
  `partly`, `not-done`, `no-answer`), `chevron-left`, `chevron-right`, `chevron-down`, `pen`, `plus`, `minus`, `close`,
  `bin`, `link`, `photo`, `calendar`, `warning`, `search`, `info`, `notes`, `zoom-in`, `zoom-out`, `star`, `clock`,
  `undo`, `drag`, `return`, `bold`, `italic`, `list`, the tabs (`today`, `week`, `inbox`, `goals`, `more`) and `live`.
  Hidden from screen readers; the control around it carries the name.
- **`Button`**: `<Button variant="primary">Save</Button>`. Variants: `primary` (the one filled button in a view),
  `secondary` (the default, outlined at 3:1), `quiet` (text), `destructive` (outlined, or `filled` when it's the
  confirming choice), `icon` (only an icon, named in full by `label`) and `link` (an underlined action inside a line
  of text). `size="compact"` is 36px on desktop and changes nothing on phone, where every button is 44pt. `icon` and
  `iconEnd` put an icon before or after the label. Without a `type` it behaves as a plain `<button>`, so one in a form
  submits it.
- **The calendar block**: `blockClass(kind, state, { short })` gives a block its look and `<BlockMarks state short look />`
  draws its answer badge, or the live dot and Now, after the inbox icon on an Inbox item's block; `blockState()` reads the state from a block's answer and time. Each
  calendar keeps its own element and geometry. Wrap the title in `.blktitle`, which is what Done strikes through.
- **`AnswerBadge`**: `<AnswerBadge answer="done" small />`, the round badge on its own, for anywhere else an answer
  shows.
- **`Chip`**: a toggle, such as a day or a filter: `<Chip pressed={on} onClick={...}>Mon</Chip>`.
- **`Switch`**: an on-off setting, such as Add to this week: `<Switch checked={on} onChange={setOn} label="Add to this
  week" />`. Its name stays the same; on or off says the rest.
- **`Segmented`**: two or three views of one thing, such as Calendar and List.
- **`TextField`**: a field with its label above, and help and error text tied to it.
- **`Card`**: a section card named by its heading, with the section's actions beside it.
- **`ListRow`**: a row's title and meta line, then its trailing icons in one fixed column, so a pencil and a chevron
  line up from row to row.
- **`Pill`**, **`Sheet`** (a dialog on desktop, a bottom sheet on phone) and **`useToast`** were built before the folder
  and are exported from it.

Everything is imported from `components/ds`. **The reference page** draws every component and every block state:
`npm run dev`, then `/reference.html?theme=dark&layout=phone` (or `light`, `desktop`). It's never shipped; the build's
only page is `index.html`. `e2e/reference.spec.ts` screenshots it in both themes at both sizes and CI compares the
screenshots, so a change to how anything looks shows in review. After a deliberate change, `scripts/reference-shots.sh`
redraws them on Linux, as CI runs; other systems skip the comparison.

## Do and don't

- **Do** take every colour, size, space, radius, shadow, layer and duration from a token. **Don't** type a raw value
  outside `tokens.css`.
- **Do** use the shared components for buttons, icons and blocks. **Don't** build a button from the `btn` class or
  draw an icon with a character.
- **Do** give each view one filled button. **Don't** fill a second one to make it stand out; make it secondary.
- **Do** say a state with a shape, an icon and a word. **Don't** say it with colour alone, and don't strike anything
  but Done.
- **Do** add a new component to this page and the reference page in the same change. **Don't** add a token for one
  screen: change the design, here, or use what's there.

## The checks

`npm test` in `frontend` runs them, and CI fails a pull request that breaks one:

- `styles/tokens.test.ts`: the 27 roles and their derived colours in both themes, every contrast pair, the budget
  (seven text styles at two weights, eight spacing steps, four radii plus the pill and circle, three shadows, six
  layers and three durations), and that nothing uses a custom property tokens.css doesn't define.
- `styles/designRules.test.ts`: no raw colour, size, spacing, radius, shadow, layer or duration outside `tokens.css`;
  no text glyph used as an icon; no button built by hand from the `btn` class outside `components/ds`. A failure names
  the file, the line and the declaration. What it allows, and why:
  - a 1px nudge in spacing, which overlaps a neighbour's border rather than spacing anything;
  - a step within a layer, `calc(var(--z-raised) + 1)`, to lift one thing over its neighbour;
  - a shadow with no blur, which is a shape (a ring, an edge, a cover, a hover's overlay) rather than elevation, in a
    token colour;
  - a looping animation, such as the spinner, which has a period rather than a duration;
  - a size between two text styles that follows the window, such as the clock's `clamp()`.
- `e2e/reference.spec.ts`: the reference page's screenshots, in both themes at both sizes.
