# ADR-0010: Deferred references (`ref`) and navigation links (`link`, `jumps`)

## Status

Accepted

## Date

2026-10-31

## Context

Formats such as ZIP and BMP are full of offsets that point somewhere else in the file: central directory entries point at local headers, BMP headers point at pixel data. Following all of them while parsing would strain the node and I/O budgets ([ADR-0007](0007-untrusted-input-limits.md)) and would let a hostile file steer the parser around. Users also want to reach such targets in one click, including data blocks that are never parsed into fields.

## Decision

Two generic, spec-level features, added with the ZIP work:

- `ref` (phase 6a, commit `3372340`): a field records `{ type, offset }` and parses nothing. The worker request `expandRef` parses the target type at that offset over the whole file when the user opens the node; the owning struct is the target's `_parent`. Per-call budgets are fresh for each expansion, with an overall cap on nodes created by all expansions of a parse result. Refs inside an expanded target are only opened on demand; nothing is followed automatically.
- `link` and `ref.jumps` (commit `7808b6b`): `link` evaluates an offset and optional size in the field's scope when the field is parsed, reads nothing, and gives the node a "go to" button that selects those bytes in the hex view. `jumps` adds shortcut buttons on a ref node that open the ref if needed and select a node at a path inside the target; the validator checks the path statically.

Both are evaluated defensively: an out-of-range or `null` link target is a quiet "no link", and only evaluation errors warn.

## Alternatives considered

- Parsing all pointer targets eagerly: not adopted. `docs/DESIGN.md` notes the node budget and ZIP's cost of about 60 nodes per entry; it does not record a measured comparison.
- Relative/pointer sugar in the language (`rel`, `ptr`): not implemented and not planned; offsets are written with `at` and expressions.

## Consequences

- The structure tree shows "open <type> @ 0x..." rows and link buttons, and App routes jumps to the same select-and-reveal path as node selection.
- Retained refs are keyed by tree path and capped (`maxRefs`); reloading a lazy page replaces them.
- A link cannot use values computed later in the file; the ZIP spec links its computed "effective" fields for this reason (see the ZIP notes in `docs/DESIGN.md`).
- `findNodeAt` must decide between the primary tree and expanded ref subtrees when both cover a byte.
