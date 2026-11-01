# ADR-0002: Svelte 5, TypeScript and Vite

## Status

Accepted

## Date

2026-10-30

## Context

The requirement states a preference for Node.js / JavaScript frameworks and invites suggestions of better options. The UI has a grid and an inspector that update frequently as the user moves a caret or selects bytes.

## Decision

The app uses Svelte 5 and TypeScript (strict), built with Vite. `docs/DESIGN.md` gave the reasons at the time: a small runtime, and fine-grained reactivity for a fast-updating grid and inspector. Framework-free logic lives in `src/core/` (byte sources, edit buffer, engine, inspector decoders) and is unit-tested without a DOM; Svelte components are in `src/ui/` and are tested with Vitest in jsdom. The project instructions (`CLAUDE.md`) record the stack as TypeScript (strict) + Svelte 5, Vite, Vitest.

## Alternatives considered

No other framework is evaluated in the design document or commit history, so none are recorded here.

## Consequences

- Core logic is independent of the framework, which keeps the parsing engine usable from a Web Worker ([ADR-0004](0004-parsing-in-a-web-worker.md)).
- Component tests need `// @vitest-environment jsdom`, and Vitest resolves Svelte's browser build in test mode (`vite.config.ts`).
