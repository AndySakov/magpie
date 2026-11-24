---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

Scope: Magpie web app (all screens). Visitor mode: operate. Primary surface: the swipe deck.
Audience/job: friends deciding what to watch or read next, on a phone, in idle moments. Task: swipe, rate, manage watchlist, import history.
Constraints: contract-shaped data only; no public score on deck; imageless items common; 360px wide; reduced motion respected.
Decision: unattended subagent run, no decision page; assigned grounded direction built as rolled. Alternate kept: streaming title wall (competitive on clarity, loses on identity because the product positions against streaming catalogues).

## Direction contract

THESIS: Magpie's plumage. A blue-black ground with an iridescent sheen that comes alive when something moves, white patches where you act, and a gold hoard for what you keep. Refuses the grey streaming-catalogue wall and the neutral dark dashboard.

OWN-WORLD: Plumage ground #0E1426 (blue-black), white patch #F2F4F8, sheen teal #1FC7B6, cobalt #4C6FFF, violet #9466FF, hoard gold #F0B44C. Each card washes the whole screen in its own ambient colour (sampled from the poster, or hashed from the title). Display face Anybody (variable width, one voice at stepped widths); UI face Figtree. Status vocabulary is fixed everywhere: want = gold, in progress = teal, finished = cobalt, dropped = rose.

STORY: The visitor sees one pick at a time, knows why it was picked, swipes it away or keeps it, and watches kept picks land in the hoard. They tune the dial from familiar to surprising and feel the deck change.

FIRST VIEWPORT: Category tabs across the top with a sliding underline. A full-height card (poster or typographic title card) fills ~68% of the viewport, reasons stacked on its foot. Below: discovery dial, then three actions: Nope, Seen it, Want (primary, right). Bottom tab bar: Deck, Watchlist, Imports, Settings.

FORM: grounded candidate 6 of 7 (the magpie's hoard / plumage), seed:a9f88b8029c229c8. Signature move: a thin-film sheen sweeps across the card as it is dragged, its hue tied to drag direction, and a kept card flies to the Watchlist tab, which glints gold. Raises: single display voice at stepped widths (from Emigre specimen); fixed state-colour vocabulary (from midnight transit); rating sheet inverts to the white patch ground (from Ikeda inversion); watchlist rows one size, rank by weight (from timetable rack).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
