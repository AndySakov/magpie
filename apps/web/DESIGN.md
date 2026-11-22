---
name: Magpie
description: Friends-only discovery for films, TV, anime and books, built on magpie plumage.
colors:
  plumage: "#0e1426"
  plumage-raised: "#161d35"
  plumage-high: "#212a48"
  patch: "#f2f4f8"
  ink-muted: "#b3bbd2"
  ink-faint: "#8690ad"
  sheen-teal: "#1fc7b6"
  sheen-cobalt: "#6b88ff"
  sheen-violet: "#a07bff"
  hoard-gold: "#f0b44c"
  drop-rose: "#e07a8d"
  light-ground: "#eef1f7"
  light-ink: "#0e1426"
typography:
  display:
    fontFamily: "Anybody, Figtree, system-ui, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 850
    lineHeight: 1.02
    letterSpacing: "-0.01em"
  card-title:
    fontFamily: "Anybody, Figtree, system-ui, sans-serif"
    fontSize: "2.1rem"
    fontWeight: 850
    lineHeight: 0.98
  body:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
rounded:
  ctl: "14px"
  card: "26px"
  sheet: "28px"
  pill: "999px"
spacing:
  gutter: "16px"
  group: "10px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.patch}"
    textColor: "{colors.plumage}"
    rounded: "{rounded.ctl}"
    height: "48px"
    padding: "0 20px"
  button-secondary:
    backgroundColor: "{colors.plumage-high}"
    textColor: "{colors.patch}"
    rounded: "{rounded.ctl}"
    height: "48px"
  want-button:
    backgroundColor: "{colors.hoard-gold}"
    textColor: "#241703"
    rounded: "{rounded.pill}"
    size: "72px"
  chip-on:
    backgroundColor: "{colors.patch}"
    textColor: "{colors.plumage}"
    rounded: "{rounded.pill}"
    height: "38px"
  input:
    backgroundColor: "{colors.plumage-raised}"
    textColor: "{colors.patch}"
    rounded: "{rounded.ctl}"
    height: "48px"
---

# Design System: Magpie

## Overview

Magpie plumage: a blue-black ground, white patches where you act, an iridescent sheen that only appears when something moves, and gold for what you keep. The deck is the product. Each card washes the whole screen in its own colour, sampled from the poster or derived from the title, so the room changes with every pick while the chrome stays quiet. Dark by default (evening, sofa, phone); a cool light theme follows `prefers-color-scheme`.

## Colors

### Primary
- **Plumage** `#0e1426`: the ground of every screen. Raised surfaces step up to `#161d35` and `#212a48`.
- **Patch** `#f2f4f8`: text, primary buttons, selected chips, and the inverted rating sheet.

### Secondary
- **Sheen** teal `#1fc7b6`, cobalt `#6b88ff`, violet `#a07bff`: used together as a gradient on the active tab pip, onboarding progress, the discovery dial rail and the drag sheen. Teal alone marks focus and success.

### Tertiary
- **Hoard gold** `#f0b44c`: the Want action, the WANT stamp, the Watchlist glint, filled stars.
- **Drop rose** `#e07a8d`: Not interested, NOPE stamp, errors, Dropped.

### Neutral
- Muted ink `#b3bbd2` for secondary text, faint ink `#8690ad` for tertiary; both tinted blue from the ground, never grey.

### Named Rules
- **Ambient owns the room.** `--amb` (a registered `<color>` property) is set per top card and transitions over 0.9s; blobs, the category underline and reason sparks read it. Nothing else sets page-scale colour.
- **Fixed status vocabulary.** want = gold, in progress = teal, finished = cobalt, dropped = rose, everywhere a status appears.

## Typography

Anybody (variable width 50-150, weight 300-900) is the only display voice; Figtree carries UI and body.

### Hierarchy
- Screen titles: Anybody 850, width 72, 2.6rem (3.2rem from 700px).
- Card titles: Anybody 850, width 78, 2.1rem.
- Typographic cards: title size and width chosen by length (short titles wide and huge, long titles condensed); year in Anybody 300 at width 50.
- Body 1rem/1.45 Figtree; labels 0.875rem 600.

### Named Rules
- **One voice at stepped widths.** Hierarchy in display type comes from the width axis and size, not from a second family.

## Layout

Single centred column, max 560px, 16px gutters, safe-area aware. Bottom tab bar (68px) with a sliding sheen pip. The deck screen is a four-row grid: category tabs, card stack (flex), dial, actions. From 700px the card stack is capped at 440px wide to keep a poster ratio.

## Elevation & Depth

Cards and floating controls use offset, blurred shadows tinted from the ground (`0 24px 48px -18px rgb(3 6 16 / .7)`). Back cards sit lower, smaller and dimmer, and scale up as the top card is dragged. Sheets rise from the bottom over a 55% plumage backdrop.

## Shapes

Controls 14px, cards 26px, sheets 28px top corners, chips and round actions fully round.

## Components

### Buttons
Primary is a white patch with plumage text. Round actions: Nope (rose X, outline), Seen it (pill, teal eye), Want (gold, larger, bookmark).

### Chips
Outline pills; selected chips invert to the patch. Status filter chips carry a status dot.

### Cards / Containers
Swipe card: full-bleed poster or typographic card, bottom scrim, title, meta line, up to two reasons with spark icons. Stamps WANT / NOPE / SEEN fade in with drag distance.

### Inputs / Fields
48px, raised plumage, strong hairline border, teal focus ring.

### Navigation
Bottom tab bar: Deck, Watchlist, Imports, Settings. Category tabs in Anybody with an ambient-coloured underline that slides between tabs.

### Discovery dial
Custom slider on a gold-to-violet rail with five ticks, labelled ends ("More of what I love", "Surprise me") and a live bucket label that changes as you drag, with a haptic tick per bucket.

## Do's and Don'ts

### Do:
- Let the top card's colour tint the whole deck screen.
- Give every imageless item a designed typographic card.
- Pair every gesture with a button and a key.

### Don't:
- Show public scores on deck cards or before the user has rated.
- Add a second display face, or use grey for secondary text.
- Put ambient colour on screens other than the deck and calibration.
