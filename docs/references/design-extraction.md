# hdrive — Design Mockup Extraction

Source: `/home/wildandev/repo/hdrive/docs/references/hdrive.html` (563 KB, 393 lines, single self-contained file).

## 0. What kind of file this is

This is **not** a hand-authored static mockup and **not** a real production React app. It is the output of an internal design tool's export format ("bundler" / `dc-runtime`, per the comment `// GENERATED from dc-runtime/src/*.ts — do not edit. Rebuild with 'cd dc-runtime && bun run build'.`) wrapped around a **custom lightweight templating micro-framework**, not JSX/component React.

Concretely, the 393-line outer HTML file is a loader shell:
- A `<style>`/`<svg>` splash screen (brand-blue `#3B3BE8` background, wireframe rectangles) shown while JS boots ("Unpacking…").
- Three `<script type="__bundler/...">` payload blocks: a `manifest` (gzip+base64 blobs — the actual JS runtime plus two vendor libraries), an `ext_resources` list (React 18.3.1 and ReactDOM 18.3.1 UMD production builds, pulled from unpkg), an empty `page_order` array, and a `template` block containing the actual page markup as a JSON-escaped string.
- The decompressed 25 KB JS module (`291cd193-...`) is the `dc-runtime`: it parses an `<x-dc>...</x-dc>` HTML template plus a sibling `<script type="text/x-dc" data-dc-script>` block containing a small class-based component (`class Component extends DCLogic`) with a `state` object and a `renderVals()` method. Bindings use Handlebars-style `{{ expr }}` syntax and custom pseudo-elements: `<sc-if value="{{ cond }}">`, `<sc-for list="{{ arr }}" as="x">`, `<sc-raw-select>`, and attributes like `sc-camel-on-click`, `style-hover` (a hover-state style swap), `sc-camel-read-only`. **React/ReactDOM are loaded as dependencies of the runtime but the actual UI is not JSX/component-tree React** — it is server-side-template-style HTML with inline `style="..."` on nearly every element (no CSS classes, no Tailwind).
- The original source is **fully recoverable** as readable, unminified template HTML + one JS class body (not minified, real variable/prop names, e.g. `s.nav`, `s.view`, `f.vis`). There is no sourcemap and no separate component file structure — everything lives in one template string and one script block.
- Three fonts are embedded as woff2 (Bricolage Grotesque, weights incl. 400/500/600, and IBM Plex Mono), loaded via `@font-face` with Google Fonts unicode-range splitting, base64-inlined into the bundle (no external network calls at runtime).
- Two design-tool-facing props are exposed for customization: `brandName` (text, default `"hdrive"`), `sidebarTheme` (`"light" | "dark"`, default light — **only** the left sidebar, not a full app dark mode), and `density` (`"comfortable" | "compact"`, adjusts file-row vertical padding 13px → 9px).

**It is one document with many screens**, driven entirely by client-side state (`state.route` and `state.view`), not a URL router — there is no history/URL logic, just `this.set({ route: ... })` / `this.set({ view: ... })` swapping which `<sc-if>` block renders. Think of it as a single-page state machine mockup, all screens present in one DOM tree, one always visible.

---

## 1. Screens / views

Top-level `route` (mutually exclusive, full-page):
1. **login** (`isLogin`) — sign-in screen.
2. **signup** (`isSignup`) — workspace-creation sign-up screen.
3. **app** (`isApp`) — the main authenticated shell (sidebar + header + content), which itself switches sub-`view`s.
4. **mobile** (`isMobile`) — a side-by-side "mobile layout" showcase (two phone-frame mockups), reached via a sidebar link "View mobile layout", not part of the real user flow — a design-reference screen.

Within `route: "app"`, `view` switches the main content pane (sidebar/header persist):
5. **list** (`isList`) — file/folder browser (default `nav: "files"`; also drives Shared / Recent / Trash via `nav`).
6. **video** (`isVideo`) — video player + stream/embed panel for one file.
7. **packages** (`isPackages`) — grid of "Package" cards.
8. **package** (`isPackage`) — single package detail: contents, access requests, audit log.
9. **people** (`isPeople`) — directory of workspace/cross-workspace people.
10. **profile** (`isProfile`) — one person's profile + their workspaces.
11. **chat** (`isChat`) — 2-pane direct-message inbox + thread, with file attach.
12. **account** (`isAccount`) — current user's account settings.
13. **members** (`isMembers`) — workspace members & roles + domain access rules.
14. **workspaces** (`isWorkspaces`) — "your workspaces" + "discover" workspace switcher/browser.
15. **request** (`isRequest`) — "preview as requester" view of a package's public request page (three sub-states: form / pending / approved).

Plus overlay/modal states layered on top of `route: "app"` (not separate routes, boolean flags): notification popover, account-menu popover, per-row visibility-badge dropdown, right-side file **detail drawer**, floating **upload progress toast**, **New workspace** modal, **Delete workspace** confirmation modal, **New package (builder)** modal, **Share** modal (Link tab / Stream tab).

### Navigation structure
Left sidebar (persistent in `app` route), top to bottom:
- Brand mark (24px rounded-square "h" mark, brand blue) + `{{ brandName }}` wordmark.
- **Workspace switcher** button (shows "WORKSPACE" mono micro-label + active workspace name + `⇅` icon) → routes to Workspaces view.
- Primary **"+ Upload"** button (solid brand blue).
- Nav list (icon-less, label + trailing count pill), items: **My files**, **Shared with me**, **Packages**, **Recent**, **Trash**, **People**, **Messages** (count = unread message total).
- Bottom-pinned: storage usage bar ("STORAGE · 62.4 / 250 GB", thin 5px bar at 25% fill) + "View mobile layout" dashed-border link button.

Top header (inside `app`, all sub-views): search input ("Search files, people, links" — static placeholder, not wired to state), spacer, notification bell button (badge = pending count, opens Activity popover), account chip (avatar initials + name + caret, opens Account menu popover with: Account settings / Members & permissions / Workspaces & join requests / — / Log out).

---

## 2. Layout

### 2a. Auth screens (login / signup)
Fixed two-column grid, no responsiveness logic detected (`grid-template-columns: 44% 1fr`, `min-height: 100vh`). Left panel is a solid-color brand panel (blue `#3B3BE8` for login, near-black `#14161A` for signup) with headline copy + trust badges/steps; right panel is a centered, max-width-360px auth card.

```
┌───────────────44%───────────────┬─────────────56%─────────────┐
│ [h] hdrive                      │                              │
│                                  │        Sign in card          │
│  Big headline (44px)             │     (max-width 360px,        │
│  Supporting copy                 │      centered)               │
│                                  │                              │
│  SOC2 · EU+US · 99.98% uptime   │                              │
└──────────────────────────────────┴──────────────────────────────┘
```

### 2b. Main app shell
Fixed grid `232px 1fr` (sidebar + main). Main is `flex column`: 64px header, then a content row `grid-template-columns: 1fr auto` (content pane + optional 336px-wide detail drawer that appears only when a file is selected).

```
┌────────────┬────────────────────────────────────────────────────┐
│            │  [search.......]        (spacer)   [bell] [avatar]  │
│  hdrive    ├────────────────────────────────────────────────────┤
│  [Workspace]│                                     ┌─────────────┐│
│  [+ Upload] │   Title + actions                   │  Detail      ││
│  My files   │   [All][Private][Shared][Public]    │  drawer      ││
│  Shared     │   ┌───────────────────────────────┐ │  (336px,     ││
│  Packages   │   │ NAME  OWNER  VIS  SIZE  MOD    │ │  optional)   ││
│  Recent     │   │ row...                        │ │              ││
│  Trash      │   └───────────────────────────────┘ │              ││
│  People     │                                     └─────────────┘│
│  Messages   │                                                    │
│  [storage]  │                                                    │
└────────────┴────────────────────────────────────────────────────┘
```
Sidebar width fixed at 232px; content grid uses `minmax()`/`auto-fill` card grids in several views (Packages: `repeat(auto-fill, minmax(304px,1fr))`; People: `minmax(292px,1fr)`; Workspaces: `minmax(300px,1fr)`) so those views reflow responsively by column count, but no explicit breakpoints/media queries exist anywhere in the file — layout is all flex/grid intrinsic sizing, not `@media`-driven. The **Mobile layout** screen is a hand-built "phone frame" showcase (2 fixed 372×760px rounded rectangles), not a real responsive breakpoint of the app shell.

### 2c. Video view
`grid-template-columns: 1fr 352px` — big player (16:9, dark) left, a fixed-width "Stream endpoint" settings card right (quality select, expiry select, embed snippet, playback URL, public-link callout).

### 2d. Package detail view
`flex-wrap` two-column-ish layout: main column `flex: 1 1 440px` (contents list + request-management panel with tabs Pending/Approved/Declined and per-row approve/decline + inline "grant access" form), side column `flex: 1 1 300px, max-width 336px` (Request settings card + Audit log card).

### 2e. Chat view
Two panes side by side: conversation list (`max-width 248px`) and an active thread panel (`flex 1 1 330px`, fixed `height: 560px`) with a scrollable message list, bubble rows, and a bottom composer bar with an attach-from-drive popover.

### 2f. Modals
All modals share one pattern: fixed full-screen scrim (`rgba(20,22,26,0.42)`), centered white card (`border-radius: 14px`, big soft shadow), header (title + × close) / scrollable body / footer with right-aligned Cancel + primary action buttons, `animation: hdRise 0.16–0.18s ease-out` entrance.

---

## 3. Components

- **Sidebar nav item** — label + trailing count badge; active state = tinted background (`#EEEEFD` light / `#22252B` dark) + bold + brand-blue text; inactive = transparent + grey text (`#5B6169` light / `#9AA0A8` dark).
- **Workspace switcher button** — bordered pill-ish button, micro-label "WORKSPACE" (uppercase, letterspaced mono) above the active workspace name, `⇅` glyph; hover → border turns brand blue.
- **Primary button** ("Upload", "New folder", "New workspace", "New package", "Create workspace", "Grant access", etc.) — solid brand-blue bg, white text, 8–9px radius, hover darkens to `#2323C4`.
- **Secondary/outline button** — 1px border `#E3E5EA`/`#C9CDD4`, white bg, hover bg `#F4F5F7`.
- **Danger/destructive button** ("Log out", "Remove", "Delete permanently", "Revoke other sessions") — text/border turns to danger red `#B4232E` on hover or by default; delete-confirm button disabled (grey) until a type-to-confirm text match.
- **Search input** — bordered, `#F4F5F7`/white bg, left-inset `⌕` glyph, 9px radius.
- **File/folder row** (list table) — grid columns `NAME(minmax 200px,2fr) | OWNER(100px) | VISIBILITY(128px) | SIZE(76px) | MODIFIED(100px) | actions(32px)`; kind glyph square (colored per extension) + filename + secondary mono subtext (e.g. duration/resolution or page count); trailing share icon button (↗).
- **Kind badge** — small colored square, per-extension color map: `MP4 #B4232E, PDF #C2410C, JPG #0F766E, XLS #1F7A4C, ZIP #5B6169, MD #3B3BE8`.
- **Visibility badge / dropdown** ("Private" grey / "Shared" indigo / "Public" green) — pill with a leading dot, click opens a small menu with 3 options (each showing label + one-line hint + checkmark on the active one).
- **Visibility filter tabs** (All / Private / Shared / Public) — segmented control, pill buttons inside a grey track, active = white bg + shadow.
- **Empty state** — dashed border card, centered icon square, title + body copy, primary CTA ("Upload a file"). Trash empty state has bespoke copy about the 30-day purge window.
- **File detail drawer** (right, 336px) — filename + size/kind, preview area (video: centered play button over dark gradient; doc: label placeholder), visibility pill-picker (3 pills), key/value metadata rows, and stacked action buttons (Share / Open player / Download).
- **Video player** — dark 16:9 box, big translucent circular play/pause button, bottom gradient overlay with thin progress bar, playhead/duration, "HLS" + quality + "CC" tags, top-left "LIVE ADAPTIVE" chip, and a below-player stat strip (Resolution / Codec / Renditions / Views).
- **Stream/embed panel** — read-only URL field + Copy button (button flips to green "Copied" for a beat), Quality select, Expiry select, dark `<pre>` embed-code block + Copy embed button, info callout (light-indigo box) when a file is Public.
- **Package card** (grid) — name + visibility badge, description, up to N "chip" tags for included file kinds + "+N more", footer meta (size/date) + pending-count badge.
- **Access-request row** — avatar-initial circle, name + status pill (pending/approved/declined), email · timestamp, optional quoted message bubble, Decline/Accept buttons; Accept expands an inline "Grant access to X" form (permission pills: "View only" / "View + download", access-expiry select, Cancel/Grant buttons).
- **Audit log entry** — colored dot + one-line text + mono timestamp, in a vertical list.
- **Person card** (People grid) — avatar circle, name + title, workspace count + shared-files count (mono meta row), Profile/Message button pair.
- **Profile header** — large avatar, name/title/email/timezone, bio paragraph, Message + "Share a package" buttons; below, a list of the person's workspace memberships (mark, name, handle · member count, access-policy tag, Join/Joined button).
- **Chat list item** — avatar, name + unread-count pill, one-line preview, active/selected state.
- **Chat bubble** — left (their) vs right (mine) alignment/color, optional file-card sub-component embedded inside a bubble (kind glyph or image thumbnail + filename + meta + one action button e.g. "Open"/"Save"), timestamp.
- **Attach-from-drive popover** — floating panel above the composer, header label "SEND FROM YOUR DRIVE", rows of kind-glyph + filename + size.
- **Toggle switch** (notification prefs, domain-access rules) — 40×23px pill track, sliding white knob, `background 0.15s` transition, on = brand blue, off = grey `#D5D8DE`.
- **Member row** (Members & permissions) — avatar+name/email, role `<select>` (Owner/Admin/Editor/Viewer), last-active text, Remove button.
- **Session row** (Account settings) — device/browser name, location · relative time, tag pill ("This device" vs "Google session").
- **Workspace card** (mine) — mark/logo square, name + "Current" pill if active, handle, role tag, description, meta row (members/storage/policy), optional "pending join requests" sub-panel (amber-tinted), Open/Delete buttons.
- **Workspace row** (discover / other workspaces) — compact horizontal row: mark, name/handle, access-policy tag, Join/Requested button.
- **Radio-style option card** (share visibility, workspace "who can find it" policy) — bordered card, custom radio dot, label + hint text; selected = brand-blue border + tinted background.
- **Upload progress toast** — fixed bottom-right floating card, per-file rows (kind glyph, filename, status text, 4px progress bar, transferred/rate mono readout), footer note "Files land in My files as Private" + "Add more" link.
- **Modal / dialog shell** — scrim + centered card, header/body/footer, used for New Workspace, Delete Workspace (destructive, type-to-confirm), New Package builder (with a checkbox file-picker list), and Share.
- **Share modal** — tabbed (Link / Stream), Link tab: visibility radio group, share-link field+copy, "people with access" list + add-by-email row; Stream tab: ready-to-stream summary chip, stream URL+copy, quality/expiry selects, embed snippet+copy, "Open in player" button.
- **Notification/activity popover** — header "Activity" + pending count, scrollable list of dot+text+time rows.
- **Account menu popover** — identity block (name, email, "Signed in with Google" tag, Admin·workspace badge) + menu list + destructive "Log out".
- **Avatar** — circular, initials, colored per-person background/foreground pair (each seeded user has its own `bg`/`fg` hex pair).
- **Phone-frame mockup** (Mobile layout screen only) — rounded-corner device frame, status bar row ("9:41", "5G ▮"), used to show the file list and a bottom sheet share flow condensed to one column.

No spinners/skeleton loaders exist for network/data loading (data is all static seed state); the only "loading" motion is the Google OAuth button's spin glyph (`hdSpin` keyframe) during the ~900ms simulated sign-in, and modal/popover entrance uses a `hdRise` fade+rise keyframe (0.13–0.18s ease-out).

---

## 4. Design tokens

### Colors
No CSS variables/theme object exists — colors are literal hex values repeated inline. Extracted palette with observed usage:

| Hex | Usage |
|---|---|
| `#3B3BE8` | Brand/accent (primary buttons, active nav, links, login panel bg, focus outline, brand mark) |
| `#2323C4` | Primary button hover (darker brand blue) |
| `#7B7BEE` | Active nav-item count-badge text |
| `#EEEEFD` | Brand-tint background (active nav bg, "Shared" badge bg, info callouts, request-approval-form bg accent) |
| `#DEDEFB` | Avatar bg tint (brand), text-selection background, page mock accents |
| `#D6D6FB`, `#AEAEF6` | Login-panel secondary text on blue bg |
| `#F7F7FE` | Very light brand tint (approval form bg, radio-selected bg) |
| `#14161A` | Primary text / near-black surfaces (signup panel bg, video player bg, dark tag text) |
| `#22252B` | Dark-sidebar border / dark video gradient stop |
| `#1B1E24`, `#2A2E36` | Dark gradient stops (video thumbnails) |
| `#5B6169` | Secondary/body text |
| `#8A9099` | Tertiary text, mono meta labels, placeholder-ish text |
| `#9AA0A8` | Dark-sidebar inactive text |
| `#A8AEB6`, `#D5D8DE` | Misc muted (toggle-off track) |
| `#C9CDD4` | Borders (dashed empty-state, outline-button borders) |
| `#E3E5EA` | Default border color (cards, inputs, dividers) |
| `#EDEFF2` | Divider lines, disabled/segmented-control track bg, dark active-nav bg alt |
| `#F2F3F5`, `#F4F5F7` | App background / subtle surface bg (page bg, input bg, hover bg) |
| `#F9FAFB`, `#FAFBFC` | Modal footer bg, chat panel bg, table header bg |
| `#FFFFFF` / `#fff` | Card/surface background |
| `#1F7A4C` | Success (green): "Public" badge, "Copied" button state, approved-request icon |
| `#166534`, `#E8F5EE`, `#F4FBF7`, `#CFE9DB`, `#1A6540` | Success tints/variants |
| `#B4232E` | Danger/destructive (log out, remove, delete-confirm, decline hover) |
| `#FDF0F1` | Danger tint background |
| `#C2410C` | Warning/amber (pending join-request text, PDF kind color) |
| `#FDE7D6`, `#FFF9F0`, `#F6E3C8` | Warning tints (pending banners, amber avatar bg) |
| `#0F766E` | Teal (JPG kind color) |
| `#1D4ED8`, `#E4EEFB` | Blue avatar variant |
| `#6B21A8`, `#F3E8FF` | Purple avatar variant |

Semantic 3-state visibility system used throughout (files, packages, share links):
- **Private** — `color #5B6169, bg #EDEFF2, dot #8A9099` — "Only you can open it"
- **Shared** — `color #3B3BE8, bg #EEEEFD, dot #3B3BE8` — "Anyone in Northwind Studio"
- **Public** — `color #1F7A4C, bg #E8F5EE, dot #1F7A4C` — "Anyone with the link, no sign-in"

### Typography
- Body/UI font: **`'Bricolage Grotesque'`**, sans-serif fallback — self-hosted variable-ish family with explicit weights 400 (body) and 500 (500 is generated too though CSS mostly calls out 400/500/600 inline); loaded via `@font-face` (vietnamese/latin-ext/latin subsets) at weights incl. 400 and 500.
- Monospace/label font: **`'IBM Plex Mono'`** — used exclusively for uppercase micro-labels, metadata, counters, timestamps, prices/sizes, and code/embed/URL fields (e.g. "STORAGE", "WORKSPACE", "NAME/OWNER/VISIBILITY/SIZE/MODIFIED" table header, "12:48 / ...", stream URLs).
- Sizes observed (px): 10.5 (mono meta), 11 (mono labels/table header), 11.5–12 (small meta/hints), 12.5–13 (body secondary/buttons), 13.5–14 (body/inputs), 14–15.5 (card titles, member names), 16–17 (section sub-headers, brand wordmark), 18 (modal titles), 20–21 (section headers alt), 24–25 (page `<h1>` titles), 27 (auth card `<h2>`), 40–44 (auth hero `<h1>`).
- Weights: 400 default, 500 (buttons/labels/medium emphasis), 600 (headings, active states, primary CTA text).
- Letter-spacing: headings use tight negative tracking, `-0.01em` to `-0.03em` scaling with size (bigger text = more negative); uppercase mono labels use positive tracking `0.05em–0.08em`.
- Line-heights: `1.05` (big hero headlines), `1.4–1.55` (body paragraphs), `1.45` for chat/message text, default (unset) for compact UI labels.

### Spacing / radius / shadow / motion
- Spacing is ad hoc px values (not a strict 4/8pt scale, but mostly multiples of ~2–4px): common gaps 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28px; card padding commonly 14–24px; page padding 28px.
- Border radius scale: 5–7px (small chips/buttons), 8–9px (standard buttons/inputs), 10–12px (cards, dropdowns), 14px (modals, big cards), 34px (phone-frame mockup), 999px (pills, avatars, toggle tracks).
- Borders: solid 1px `#E3E5EA` default; 1px dashed `#C9CDD4` for empty states / "outline" affordances; 1.5–2px solid `#3B3BE8` for selected/active radio-style cards.
- Shadows:
  - `0 1px 4px rgba(0,0,0,0.12)` — bundler loading badge only.
  - `0 1px 2px rgba(20,22,26,0.09)` — active segmented-tab.
  - `0 4px 16px rgba(59,59,232,0.09)` — package-card hover (brand-tinted).
  - `0 12px 32px rgba(20,22,26,0.12–0.16)` — dropdown/popover menus.
  - `0 16px 40px rgba(20,22,26,0.16)` — upload toast.
  - `0 18px 44px rgba(20,22,26,0.14–0.2)` — phone-frame mockups.
  - `0 24px 64px rgba(20,22,26,0.28)` — modal dialogs.
- Motion: two keyframes only — `hdSpin` (360° rotate, 0.9s linear infinite — OAuth spinner) and `hdRise` (opacity 0→1 + translateY(6px)→0, 0.13–0.18s ease-out — used for every popover/drawer/modal/toast entrance). A few explicit `transition:` declarations: `background 0.15s` (toggle switches), `width 0.4s ease` / `width 0.4s linear` (progress/storage bars). All other state changes (hover, active) are handled via a custom `style-hover` attribute in the templating runtime rather than CSS `:hover`/transitions — i.e., hover looks like an instant style swap in this format, but a real frontend should implement it as a normal CSS `:hover` + transition.
- Global stylesheet basics: `box-sizing: border-box` reset, page background `#F4F5F7`, default text color `#14161A`, link color `#3B3BE8` (hover `#2323C4`, underline on hover), `input:focus { outline: 2px solid #3B3BE8; outline-offset: 0; }`, `::selection { background: #DEDEFB; }`.

### Dark mode
There is **no full app dark mode**. The only dark-theme surface is an optional **sidebar-only** theme (`sidebarTheme: "light" | "dark"`, a design-tool prop, default light):
- Light sidebar: bg `#FFFFFF`, border `#E3E5EA`, brand text `#14161A`, active-nav bg `#EEEEFD` / text `#3B3BE8`, inactive text `#5B6169`.
- Dark sidebar: bg `#14161A`, border `#22252B`, brand text `#FFFFFF`, active-nav bg `#22252B` / text `#FFFFFF`, inactive text `#9AA0A8`, active count-badge text `#9AA0A8` (vs `#7B7BEE` on light).
The rest of the app (header, content, modals) has no dark variant defined anywhere in the file. The signup screen's left panel and the video player and phone-mockup share-sheet incidentally use near-black (`#14161A`) as a one-off design choice, not a togglable theme.

A separate `density` prop (`"comfortable" | "compact"`) only changes file-row vertical padding (13px ↔ 9px) — not a real breakpoint or theme, just a design-tool knob.

---

## 5. Interactions and states

- **Hover**: nearly every interactive element defines an explicit hover style via `style-hover="..."` (border/bg/color change) — buttons, nav items, table rows' share icon, badges, links. No focus-visible styling beyond the global `input:focus` outline.
- **Selection**: single-selection only, no multi-select/bulk actions anywhere (no checkboxes on file rows, no "select all", no bulk delete/move/share). The one checkbox-list UI is the **Package builder's file picker** (multi-select files into a package via checkbox rows) and a boolean "Auto-approve members" checkbox — not file-list bulk selection.
- **Filtering**: visibility filter tabs (All/Private/Shared/Public) on the file list; live-filtered search on People (`setUserQuery`) and Workspaces (`setWsQuery`) — both simple case-insensitive substring match against name/email/title or name/handle. The global header search bar and the file-list itself have **no working search** (placeholder-only input).
- **Sorting**: none — no sortable column headers, no sort-order control anywhere.
- **Pagination / infinite scroll**: none — every list is a small static seed array (2–9 items), no "load more"/page controls.
- **Drag-and-drop**: no explicit dropzone markup or drag event handlers found (`sc-camel-on-drop`, dropzone styling, etc. absent) — upload is triggered only via an "Upload"/"+" button that opens the upload-progress toast with pre-seeded fake progress rows; there's no visual affordance for dragging files onto the window.
- **Context menus**: none (no right-click menu); the closest analog is the per-row visibility-badge dropdown (click, not right-click) and the account/notification popovers.
- **Modals/drawers**: New workspace, Delete workspace (destructive, requires typing the exact workspace name to enable the confirm button — `canDelete` checks case-insensitive name match), New package (builder), Share (Link/Stream tabs) are true modal dialogs (scrim + click-outside-to-close via `sc-camel-on-click="{{ closeX }}"` on the scrim, `stop` handler on the card to prevent bubbling). The file **detail panel** is an inline right-hand drawer, not a modal.
- **Confirmation flows**: only "Delete workspace" has a type-to-confirm destructive pattern. Package access requests have an Accept → inline "Grant access" sub-form (choose permission + expiry) → Confirm, rather than instant accept. No confirmation on member removal or session revocation (single click).
- **Keyboard**: only one shortcut implemented — Enter key in the chat composer sends the draft message (`chatKeyDown`); no other keyboard shortcuts, no focus-trap logic visible in the modals.
- **Copy-to-clipboard affordance pattern**: every "Copy"-style button (share link, stream URL, embed snippet, package request link) flips its own label to "Copied"/green background for a beat via shared `copyBtn(key,label)` helper — a consistent micro-interaction across 4+ places.
- **Simulated async**: Google OAuth sign-in/sign-up sets `oauth:true` (button shows spinner + "Redirecting to Google…"), then after 900ms auto-completes to `route:"app"`. This is the only simulated network delay in the whole mockup.
- **Package request lifecycle** (three states shown in the "preview as requester" screen): request form → "Request sent — waiting on {owner}" pending state (amber) → "Access granted" approved state (green) with Open package / Download all actions. Auto-approve packages skip straight to "Get instant access" copy.
- **Join-workspace flow**: "Discover" workspaces show a Join/Requested button; owners see pending joiners as an inline amber panel on their own workspace card with per-request Accept/Decline.

---

## 6. Content and copy (verbatim, representative)

**Login screen**: "Every file your team ships, in one place." / "Upload anything. Keep it private, share a link, or publish it. Video streams straight from the URL — no download, no transcode wait." / trust row: "SOC 2 Type II", "EU + US regions", "99.98% uptime" / "Sign in" / "Welcome back to Northwind Studio." / "Continue with Google" / "We only read your name, email, and profile photo. hdrive never touches your Google Drive files." / "GOOGLE ONLY" / "hdrive has no passwords. Every account is a Google account, so access follows whatever your admin already enforces — 2FA, device policy, and offboarding included." / "No account yet? Create a workspace"

**Signup screen**: "Start a workspace in about a minute." / numbered list "01 250 GB pooled storage on the free tier", "02 Unlimited link shares with expiry control", "03 HLS streaming endpoints for every video" / "No card required" / "Create your workspace" / "You'll be the first admin." / "Sign up with Google" / "Your Google account becomes the owner. Anyone on your email domain can be invited afterwards." / "Sign-up is Google only..." / placeholder workspace name "Northwind Studio" / "Already have one? Sign in"

**Sidebar/nav labels**: My files, Shared with me, Packages, Recent, Trash, People, Messages; "STORAGE · 62.4 / 250 GB"; "View mobile layout".

**File list**: table header NAME/OWNER/VISIBILITY/SIZE/MODIFIED; tabs All/Private/Shared/Public; view titles: "My files" / "Everything you and your workspace have uploaded.", "Shared with me" / "Files other members gave you access to.", "Recent" / "Opened or changed in the last few days.", "Trash" / "Deleted files are purged after 30 days."; empty state "Trash is empty" / "Files you delete land here for 30 days before they are purged for good."; other empty state "Nothing {vis} yet" / "Change the visibility of a file, or upload something new — it starts out private and you decide from there."

Seed file rows (demonstrates naming/IA conventions): `video.mp4` (248 MB, Public, 12:48 · 2160p), `document.pdf` (1.2 MB, Shared, 18 pages), `image.jpg` (3.4 MB, Private, 4032×3024), `onboarding-walkthrough.mp4` (512 MB, Shared, 24:03 · 1080p), `q3-budget.xlsx` (88 KB, Private, 6 sheets), `brand-assets.zip` (1.8 GB, Shared, 212 items), `launch-notes.md` (12 KB, Shared, 1,940 words), `handbook.pdf` (6.1 MB, Shared, 64 pages), `type-specimen.pdf` (2.3 MB, Shared, 12 pages).

**Video view**: "← All files"; "Stream endpoint" / "Plays in any HLS client. No download required."; "PLAYBACK URL"; QUALITY select (Auto (adaptive)/2160p/1080p/720p); LINK EXPIRES select (Never/24h/7d/30d); "EMBED SNIPPET"; callout: "This file is public, so the stream URL works without a sign-in. Switch it to Shared to require workspace access."; stats: RESOLUTION 3840×2160, CODEC H.264/AAC, RENDITIONS 2160p·1080p·720p·480p, VIEWS 1,284.

**Packages**: "Packages" / "Bundles of files shared as one unit. Members request access; you decide."; "New package"; seed packages: "Q3 Launch Kit", "Brand Library 2026", "Onboarding for New Hires" with real-sounding descriptions and creation dates.

**Package detail**: "← Packages"; "Preview as requester"; "Contents" + "Shared documents only" tag; "Add files"; request rows with real message text e.g. "Need the launch video and the one-pager for the Jakarta partner briefing on Thursday."; "Decline"/"Accept"; "Grant access to {name}"; PERMISSION pills "View only"/"View + download"; ACCESS EXPIRES (Never/7/30/90 days); "Request settings"; "Auto-approve workspace members" + explanatory copy; "REQUEST LINK"; "Audit log".

**People**: "People" / "Find someone, see the workspaces they are in, and ask your way in."; search placeholder "Search people by name, email, or role"; cards show N workspaces + shared-files count; "No one matches "{query}"."

**Profile**: bio copy per seed user (e.g. Priya Sharma: "Cuts the launch films and keeps the brand library honest. Ask me before you re-export anything."); workspace membership rows with policy tag and Join/Joined button.

**Chat**: "Messages" / "Ask for access, send a file, sort it out in a line or two."; composer placeholder "Write a message"; popover header "SEND FROM YOUR DRIVE"; sample thread includes a text message plus an attached file card ("onboarding-walkthrough.mp4", 512 MB, "24:03 · streams in browser").

**Account settings**: "Account settings" / "Your identity comes from Google. hdrive stores preferences and sessions, nothing else."; "Manage on Google" / "Refresh profile from Google"; Notifications toggles: "Package access requests", "Mentions in messages", "Weekly activity digest"; "Active sessions" list (device/location/time + "This device"/"Google session" tags); "Revoke other sessions".

**Members & permissions**: "{N} people in {workspace}."; "Invite from Google Workspace"; callout: "Invites go to Google accounts on northwind.co. There are no password invites or guest logins — someone without a Google account on an allowed domain cannot be added."; table MEMBER/ROLE/LAST ACTIVE; role options Owner/Admin/Editor/Viewer; "Domain access" toggles: "Anyone on the domain can request to join", "Auto-approve as Viewer".

**Workspaces**: "Workspaces" / "Switch between the teams you belong to, or find one and ask to join."; "New workspace"; "YOUR WORKSPACES · N"; per-card members/storage/policy meta, pending join-request panel; "DISCOVER · N"; empty-discover copy: "Nothing else found. Workspaces are only listed if their admin made them discoverable."

**New workspace modal**: fields "Workspace name" (placeholder "Northwind Field Ops"), "Handle" (prefixed `hdrive.io/`, placeholder "field-ops"), "What it is for" (textarea), "WHO CAN FIND IT" radio: "Open to requests" vs "Invite only".

**Delete workspace modal**: "Delete {name}" + dynamic warning copy; "Type {name} to confirm"; "Keep it" / "Delete permanently".

**New package modal**: "Package name" (placeholder "Q4 Partner Kit"), "Description", "FILES IN PACKAGE · SHARED ONLY" checklist, "WHO CAN REQUEST" (fixed to "Workspace members only" with explanatory copy — no other option currently wired), "Auto-approve members" checkbox.

**Share modal**: tabs "Link"/"Stream"; "WHO CAN OPEN THIS" radios (Private/Shared/Public with the same 3-tier hints as elsewhere); "SHARE LINK" + Copy; "PEOPLE WITH ACCESS" list + "Add people by email" + Invite; Stream tab mirrors the video view's stream/embed panel.

**Request-access preview screen**: "← Exit preview"; "Viewing as Priya Sharma" tag; "PACKAGE · NORTHWIND STUDIO"; "Request access"; textarea placeholder "What do you need it for? Owners approve faster with context."; CTA "Send request" or "Get instant access" (if auto-approve); pending state "Request sent — waiting on {owner}"; approved state "Access granted" + "Open package"/"Download all".

**Mobile layout screen**: "Mobile layout" / "Same model, one column: list, share sheet."; phone 1 = file list (search, All/Private/Shared/Public chips, rows, bottom tab bar Files/+/Shared); phone 2 = video + share bottom-sheet (Link/Stream segmented control, stream URL+Copy, Public/Shared radios).

---

## 7. Gaps vs. the existing backend surface

| Backend surface | Present in design? | Notes |
|---|---|---|
| Sign-in | **Present** | Google-OAuth-only login screen + matching signup screen. No email/password fields anywhere (explicitly copy-called-out as passwordless). |
| File/folder browsing | **Present** | Full file table view with visibility filter tabs, per-row visibility badge/menu, detail drawer. **No folders are modeled** — all seed items are flat files (no folder rows, no breadcrumbs, no "New folder" behavior beyond a button that has no wired handler visible). |
| Upload with progress | **Present** | Floating toast with per-file progress bar, transferred/rate readout, status text. Upload button exists in sidebar, header, and empty state. No drag-and-drop dropzone UI. |
| Download | **Partial** | A "Download" button exists in the file detail drawer and "Download all" in the approved-request state, but no wired download logic/progress — it's a static button. |
| Video playback with seeking | **Partial** | Rich player chrome (play/pause, progress bar, playhead/duration, quality/HLS/CC tags, resolution/codec/renditions/views stats) but the progress bar and playhead are **not scrubbable/seekable** in the markup — `togglePlay` only flips a play/pause glyph and a static `progressStyle`; no seek handler. |
| Rename | **Absent** | No rename UI/action found anywhere (file rows, detail drawer, context menu — none exists). |
| Move | **Absent** | No move-to-folder UI (consistent with no folder model). |
| Trash and restore | **Partial** | Trash is a real nav destination with its own empty-state copy ("purged after 30 days"), but the seed data always renders it empty (`nav === "trash"` short-circuits to `[]`) and there is **no restore action** anywhere in the file. |
| Share-link creation with expiry/password/revocation | **Partial** | Share modal + video/stream panel both have link creation, visibility tiers, and an **expiry select** (Never/24h/7d/30d, or 7/30/90 days for package grants). **No password-protection option** and **no explicit "revoke link" action** (only implicit via changing visibility back to Private). |
| Password-unlock screen for a shared link | **Absent** | No such screen or state exists in the `route`/`view` state machine. |
| Per-item permission grants (user and group) | **Partial** | Per-user grants exist: package access-request approval flow lets an owner set permission ("View only" / "View + download") and expiry per requester; the Share modal has a "People with access" list + "Add people by email". **No group-based grants** — the app models individual members with a role (Owner/Admin/Editor/Viewer) but there is no "Groups" entity/UI anywhere. |
| Space (workspace) management | **Present** | Full Workspaces view (list mine, discover others, join requests, create, delete-with-confirmation), Members & permissions view (roles, domain access rules), workspace switcher in sidebar. |
| Admin: storage backends | **Absent** | No admin screen/state for configuring storage backends exists at all. |
| Admin: users (global/system-level) | **Partial** | Only workspace-scoped "Members & permissions" exists (role table + domain rules); no cross-workspace/system admin user-management screen. |
| Admin: groups | **Absent** | No group entity or admin UI anywhere in the state or template. |

**Summary of what's genuinely new/extra in the design beyond the listed backend surfaces**: a directly-modeled **Packages** feature (bundle files, request/approve access, auto-approve, audit log) and an in-app **direct-messaging/chat** feature with drive-file attachments — neither of which was in the gap-list backend surface, so treat them as design-only additions to confirm against product scope before building.
