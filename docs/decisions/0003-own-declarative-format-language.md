# ADR-0003: Own declarative JSON format language, Kaitai-style, with our own interpreter

## Status

Accepted

## Date

2026-10-30

## Context

Users describe binary formats (and the app ships BMP and ZIP specs) so that files can be decoded into a navigable tree with byte ranges. The requirement asks for "pre-defined building blocks" for formats. Kaitai Struct is an existing language for this.

## Decision

Formats are JSON documents (`src/core/engine/schema.ts`) using Kaitai Struct naming and semantics (types made of fields, `repeat`, `if`, `switch`, `enum`, `_io`, `_parent`, `_root`, `_index`), interpreted by the project's own engine (`src/core/engine/`), not by Kaitai. The reference for spec authors is [`docs/SPEC-LANGUAGE.md`](../SPEC-LANGUAGE.md).

The reasons recorded in `docs/DESIGN.md` for not using Kaitai itself:

- the Kaitai JS runtime needs the whole file in memory,
- it has no byte-range tracking (the structure tree and hex highlighting need the offset and size of every node),
- the compiler is GPL-3.

The expression language is hand-written (no `eval`), with exact integers (BigInt), checked arithmetic and explicit null semantics. Integer byte order is always explicit.

## Alternatives considered

- Using Kaitai Struct (runtime and compiler): rejected for the three reasons above.
- No other alternative is recorded.

## Consequences

- The project owns the language, its validator, interpreter, documentation generator and visual builder, and must keep them consistent. The engine implements what the built-in specs needed (phases 3 and 6); `rel`/`ptr`, `align`, TLV `chunks` and `scanBackFrom` are not implemented and not planned (see [`DESIGN.md`](../DESIGN.md)).
- Existing Kaitai `.ksy` files are not loadable; specs are not source-compatible with Kaitai.
- Because the language is declarative and interpreted, a spec cannot execute code, which is what makes loading user specs tolerable ([ADR-0007](0007-untrusted-input-limits.md)).
