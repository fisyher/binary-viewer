# ADR-0007: Treat input files and specs as untrusted; enforce limits and budgets in the engine

## Status

Accepted

## Date

2026-10-30

## Context

The project rules (`CLAUDE.md`) say every input file is untrusted: bounds-check all reads and never trust lengths from the file. Specs, which can be imported, loaded from a folder or typed by the user, drive the interpreter, so they are untrusted too.

## Decision

The engine enforces limits at three levels.

- **Specs.** A hand-written validator (`src/core/engine/validate.ts`) checks every key, rejects unknown ones, caps sizes (spec bytes, number of types, fields, cases, enum entries, expression length and depth, type nesting) and reports errors with JSON paths. Type cycles are accepted only when a field on the cycle has `size`, `at`, `find`, `if`, `ifMagic` or `repeat`.
- **Expressions.** A hand-written parser and evaluator (`expr.ts`), never `eval`; exact integers with checked arithmetic and a 256-bit result cap.
- **Parsing.** `DEFAULT_LIMITS` in `interpret.ts` bounds recursion depth, retained nodes, skim nodes, steps, total bytes read, number of reads, string sizes, `find` windows and candidates, probe steps, `lookup` scans, and `ref` counts. Array counts are bounded by the bytes that remain, (type, offset) cycles are detected, progress is checked, and parsing is cancellable through an `AbortSignal`. Failures become error nodes and diagnostics; `parse` does not throw on bad data.

Text taken from files and specs is not rendered raw: the inspector and structure tree show control, format and bidi characters as visible escapes, the generated Markdown escapes all specials, and the HTML export embeds a Content-Security-Policy with `default-src 'none'`.

## Alternatives considered

None recorded. The limits follow from the project rule and from letting users supply specs.

## Consequences

- A hostile or malformed file or spec produces a partial tree and messages, not a hang or memory exhaustion.
- Legitimate large inputs can hit a budget (for example the 100,000-node limit); arrays are therefore lazy and refs are opened on demand ([ADR-0010](0010-deferred-refs-and-navigation-links.md)).
- Every limit is a behaviour that needs a test; the engine has dedicated robustness tests.
- The limits that spec authors meet are summarised in [`docs/SPEC-LANGUAGE.md`](../SPEC-LANGUAGE.md#limits); the complete engine list is in `docs/DESIGN.md`.
