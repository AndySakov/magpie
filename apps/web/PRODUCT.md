# Product

<!-- impeccable:product-schema 1 -->

All facts below are inferred from the repo's SPEC.md and the build brief; no interview was run (written by a subagent with no question channel). Confirm or correct.

## Platform

web

## Stack

Vite + React 19 + TypeScript, Effect 4 typed HttpApi client against `@magpie/contract`, `motion` for gesture physics, plain CSS. PWA via vite-plugin-pwa. Chosen by the project owner.

## Users

A small circle of friends (the owner plus up to ~16 invitees) who watch films, TV and anime and read books. They open it on their phones in idle moments (sofa, commute, bed) to find the next thing, and on desktop occasionally to import history.

## Product Purpose

Organic discovery of movies, TV, anime and books from each person's history, stated preferences and swipe feedback. Success: a person finds something they actually start within a few swipes, and their watchlist reflects what they really want.

## Positioning

Not a streaming catalogue and not a social tracker. It learns taste from polarizing titles and borrowed neighbours, explains every pick ("Because you liked X"), lets the person turn a dial from "more of what I love" to "surprise me", and hides public scores until they have rated, so nobody's opinion is anchored.

## Operating Context

- Onboarding: pick categories, genres per category, then a calibration swipe deck; imports from Letterboxd, IMDb, Goodreads, MAL files and AniList username.
- Daily loop: swipe deck per category (right = interested, left = not interested, "Seen it" = rate), watchlist with statuses want / in progress / finished / dropped, manual progress.
- No auth in v1: a profile picker on a shared instance.

## Capabilities and Constraints

- Every request and response is defined by `packages/contract` (Effect HttpApi). The UI never invents fields.
- `publicScore` is null until the user rated the item; never shown on deck cards.
- Many items have no image (anime database forbids hotlinking MAL images; many books lack covers). Imageless cards must look designed, not broken.
- Running cost near zero; must work at 360px wide and offline-shell as a PWA.
- Undecided: auth, friends' ratings, where-to-watch (later phases).

## Brand Commitments

Name: Magpie. Friends-only, no public launch. No logo exists yet.

## Evidence on Hand

No real catalogue data in the web app; mock mode (`VITE_MOCK=1`) uses synthetic fixtures shaped like the contract. Titles in fixtures are real works used for demonstration only.

## Product Principles

1. Taste is personal: never anchor with crowd scores before the person rates.
2. Every recommendation explains itself.
3. Swiping is the core ritual and must feel physical and fast.
4. Imports are never lossy: low-confidence matches are confirmed by the person, never dropped.

## Accessibility & Inclusion

Every swipe action has a button and keyboard equivalent. Respect prefers-reduced-motion.
