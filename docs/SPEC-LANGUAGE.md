# Format spec language

This is the reference for writing format specs for Binary Viewer. A spec is a JSON document that describes a binary format as a list of types made of fields. The app's own engine interprets it; a spec never runs code.

The vocabulary (types, fields, `repeat`, `if`, `switch`, `enum`, `_io`, `_parent`, `_root`, `_index`) follows [Kaitai Struct](https://kaitai.io/), but the format is not KSY: specs are JSON, the expression grammar is the one described below, and any key not listed here is rejected as unknown. See [Not supported](#not-supported).

How to use a spec: in the **Formats** tab, create or import a spec, edit it in the JSON editor (or with the visual builder), and use the live preview against the file open in the viewer. The same schema generates the documentation shown for each spec.

Sources of truth, if this page and the app disagree: [`src/core/engine/schema.ts`](../src/core/engine/schema.ts) (types), [`validate.ts`](../src/core/engine/validate.ts) (rules and limits), [`expr.ts`](../src/core/engine/expr.ts) (expressions), [`interpret.ts`](../src/core/engine/interpret.ts) (behaviour). Engine internals (budgets, laziness, probe parsing) are in [`DESIGN.md`](DESIGN.md). Complete real specs: [`src/formats/bmp.json`](../src/formats/bmp.json) and [`src/formats/zip.json`](../src/formats/zip.json).

Every JSON block on this page is a complete spec that passes the validator. Longer blocks show several features at once; the field names are only illustrative.

## Contents

- [Top-level fields](#top-level-fields)
- [Types and fields](#types-and-fields)
- [Field types](#field-types)
- [Field modifiers](#field-modifiers)
- [Positioning: `at` and `find`](#positioning-at-and-find)
- [Guards: `if` and `ifMagic`](#guards-if-and-ifmagic)
- [Computed fields: `value`](#computed-fields-value)
- [Deferred pointers and links: `ref`, `jumps`, `link`](#deferred-pointers-and-links-ref-jumps-link)
- [Expressions](#expressions)
- [Limits](#limits)
- [Not supported](#not-supported)

## Top-level fields

| Key | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. |
| `id` | yes | Short identifier: letters, digits, `_` and `-`, starting with a letter or digit, up to 64 characters. Specs synced to a local folder are stored as `<id>.json` and need a lower-case id (`a-z`, `0-9`, `_`, `-`; Windows device names such as `con` or `nul` are refused). |
| `name` | yes | Display name, 1 to 200 characters. |
| `endian` | no | `"le"` or `"be"`: the byte order of multi-byte numeric types written without a suffix. |
| `extensions` | no | Up to 64 lower-case file extensions without the dot (`a-z`, `0-9`, `_`, `+`, `-`, 1 to 16 characters). |
| `detect` | no | Up to 16 magic-byte rules. |
| `doc` | no | Description, up to 20,000 characters. Plain text. |
| `root` | yes | Name of the type that describes the whole file. |
| `types` | yes | Map of type name to type definition (at least one). |
| `enums` | no | Map of enum name to an `integer -> label` map. |

Type, field and enum names match `[A-Za-z][A-Za-z0-9_]{0,63}`: letters, digits and `_`, starting with a letter. A type name may not equal a built-in type name (`u4`, `str`, `bytes`, `value`, ...).

### Detection

`detect` rules identify the format of a file when it is opened. Each rule is `{ "at", "bytes", "mask"? }`:

- `at` is an integer offset. A negative value counts from the end of the file (`-4` is the last four bytes).
- `bytes` is 1 to 64 hex bytes, whitespace allowed (`"42 4D"`).
- `mask` is hex of the same length as `bytes`; only the bits set in the mask are compared. An all-zero mask is rejected because it would match every file.

A spec has a magic match only when every rule matches. A rule whose bytes lie partly outside the file does not match. The viewer ranks specs: a magic match scores 100 plus the number of significant magic bytes (at most 16); an extension match adds 30, or only 10 when the spec has `detect` rules that did not match. A spec with no evidence either way is not offered. You can always pick another format by hand.

### Example

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "name": "Demo container",
  "endian": "le",
  "extensions": ["dem"],
  "detect": [
    { "at": 0, "bytes": "44 45 4D 4F" },
    { "at": -4, "bytes": "45 4E 44 00", "mask": "FF FF FF FF" }
  ],
  "doc": "A small example container: magic, a kind byte and a record count.",
  "root": "file",
  "enums": {
    "kind": { "0": "none", "0x01": "text", "-1": "error" }
  },
  "types": {
    "file": {
      "doc": "The whole file.",
      "fields": [
        { "name": "magic", "type": "str", "size": 4, "encoding": "ascii", "expect": "DEMO" },
        { "name": "kind", "type": "u1", "enum": "kind" },
        { "name": "count", "type": "u2" }
      ]
    }
  }
}
```

### Enums

An enum maps integer keys, written as decimal or `0x` hexadecimal strings with an optional leading minus, to labels (up to 200 characters, up to 4096 entries per enum). A field refers to it with `"enum": "name"`; the field then shows `label (value)`, or `value (unknown name)` when the value has no entry.

## Types and fields

A type is `{ "doc"?, "fields": [...] }`. Fields are parsed in order from the type's start; each sequential field starts where the previous one ended. A type has up to 1024 fields, field names are unique within a type, and `and`, `or`, `not`, `null`, `true`, `false`, `min`, `max` and `lookup` are not allowed as field names.

A field is an object with `name`, `type` and any of the modifiers below. Allowed keys: `name`, `type`, `size`, `terminator`, `encoding`, `at`, `find`, `if`, `ifMagic`, `repeat`, `enum`, `bits`, `expect`, `fatal`, `value`, `ref`, `link`, `doc`, `assert`.

The root type is parsed at offset 0 over the whole file. A user type used as a field type is parsed as a nested struct; its fields are reachable from expressions as `field.member`.

## Field types

| Type | Meaning |
|---|---|
| `u1` `u2` `u4` `u8` | Unsigned integers of 1, 2, 4, 8 bytes. |
| `s1` `s2` `s4` `s8` | Signed (two's complement) integers. |
| `f4` `f8` | IEEE 754 single and double floats. |
| `str` | Text; needs `size` or `terminator`. |
| `bytes` | Raw bytes; needs `size`. |
| a type name | A user-defined type (struct). |
| `{ "switch", "cases", "default"? }` | A type chosen from a value. |
| `value` | A computed field that consumes no bytes. |

### Byte order

Byte order is always explicit and the host's is never used. A multi-byte numeric type takes a suffix: `u4le`, `u4be`, `s2be`, `f8le`. Without a suffix it uses the spec's `endian`; if the spec has no `endian`, a suffix-less multi-byte type is a validation error. `u1` and `s1` need neither. Integers are decoded exactly, including 64-bit values.

```json
{
  "schemaVersion": 1,
  "id": "types-demo",
  "name": "Primitive types",
  "endian": "be",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "version", "type": "u2" },
        { "name": "offset", "type": "u4le", "doc": "Explicit little-endian, whatever the spec default is." },
        { "name": "delta", "type": "s4" },
        { "name": "scale", "type": "f4" },
        { "name": "ratio", "type": "f8le" },
        { "name": "name", "type": "str", "size": 8, "encoding": "ascii", "terminator": 0 },
        { "name": "title", "type": "str", "terminator": 0, "encoding": "utf8" },
        { "name": "salt", "type": "bytes", "size": 4 },
        { "name": "rest", "type": "bytes", "size": "eos" }
      ]
    }
  }
}
```

A numeric type has a fixed size, so `size` on it is an error.

### Strings: `str`

- `size` gives the length in bytes (a number, an expression, or `"eos"` for "to the end of the enclosing stream").
- `terminator` is the code unit that ends the string (`0` for NUL), an integer from 0 to 65535. Values above 255 need a `utf16le` or `utf16be` encoding. With `size`, the text is cut at the terminator but the field still occupies `size` bytes. Without `size`, the engine scans for the terminator and the field includes it; if it is not found within the enclosing stream (and within 1 MiB) the field is an error.
- `encoding` is one of `ascii`, `latin1`, `cp437`, `utf8` (the default), `utf16le`, `utf16be`.
- Only the first 4096 bytes of a string are decoded; longer ones are shown as truncated.

### Raw bytes: `bytes`

`size` is required. Fields of up to 64 bytes are read completely; larger ones keep a 16-byte preview and the node still covers the full size.

### Switch types

A field's type can be chosen by a value:

```json
{
  "schemaVersion": 1,
  "id": "switch-demo",
  "name": "Switch type",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "kind", "type": "u1" },
        { "name": "len", "type": "u2" },
        {
          "name": "payload",
          "type": { "switch": "kind", "cases": { "1": "text_rec", "2": "num_rec" }, "default": "raw_rec" },
          "size": "len"
        }
      ]
    },
    "text_rec": { "fields": [{ "name": "text", "type": "str", "size": "eos", "encoding": "ascii" }] },
    "num_rec": { "fields": [{ "name": "value", "type": "u4" }] },
    "raw_rec": { "fields": [{ "name": "data", "type": "bytes", "size": "eos" }] }
  }
}
```

`switch` is an expression. Each key in `cases` is an expression too (normally a literal such as `1`, `"abc"` written as `"\"abc\""`, or `0x10`) and is compared with `==` semantics; the first matching case wins. The values are type names (a built-in or a user type; `value` is not allowed here). With no matching case and no `default`, the field is an error. Up to 256 cases.

## Field modifiers

### `size`

A number, an expression, or `"eos"`.

- On `str` and `bytes` it is the length in bytes.
- On a user type it creates a **substream**: the struct is parsed inside exactly that many bytes, `_io.size`/`_io.end` describe the substream, and the parent's cursor always moves on by `size` afterwards. A failure inside a sized struct is recorded on its own nodes but does not stop the parent (so one malformed record in a length-prefixed list does not hide the next ones).
- A size that exceeds the bytes left in the enclosing stream is clamped to what is left and reported as an error.
- `size` together with `repeat` is rejected (the size would be ignored). Put the sized element in its own type and repeat that.

### `terminator`, `encoding`

Only valid on `str`; see [Strings](#strings-str).

### `repeat`

Makes the field an array. Exactly one of:

| Form | Meaning |
|---|---|
| `{ "count": expr }` | A fixed number of elements. A count larger than the remaining bytes can hold is clamped and reported. |
| `{ "until": expr }` | Parse elements until the expression is true after an element. `_` is the element just parsed, `_index` its index. |
| `"eos"` | Parse elements until the enclosing stream ends. Trailing bytes that do not form a whole fixed-size element give a warning. |

An element that consumes no bytes is an error. Large arrays are loaded lazily (the first 1000 elements are parsed when the file opens, the rest on demand), which affects what `lookup` can see: see [Functions](#functions).

```json
{
  "schemaVersion": 1,
  "id": "repeat-demo",
  "name": "Repeat",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "count", "type": "u2" },
        { "name": "records", "type": "record", "repeat": { "count": "count" } },
        { "name": "items", "type": "item", "repeat": { "until": "_.kind == 0" } },
        { "name": "tail", "type": "u2", "repeat": "eos" }
      ]
    },
    "record": { "fields": [{ "name": "id", "type": "u2" }, { "name": "flags", "type": "u1" }] },
    "item": { "fields": [{ "name": "kind", "type": "u1" }, { "name": "arg", "type": "u1" }] }
  }
}
```

### `enum`

`"enum": "name"` names an entry of the top-level `enums`. Only valid on a plain integer type (not floats, not switch types, not arrays).

### `bits`

Splits an integer into named bit fields. Each entry is `{ "name", "offset", "width", "doc"? }`. Bit 0 is the least significant bit of the value after byte-order conversion (for signed types, of the two's-complement representation); `offset` counts up from there. `offset + width` may not exceed the type's width. Up to 64 entries; names are unique. Each entry becomes a child node of the field.

```json
{
  "schemaVersion": 1,
  "id": "bits-demo",
  "name": "Bit fields",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        {
          "name": "flags",
          "type": "u2",
          "bits": [
            { "name": "compressed", "offset": 0, "width": 1, "doc": "Bit 0." },
            { "name": "level", "offset": 1, "width": 3 },
            { "name": "reserved", "offset": 4, "width": 12 }
          ]
        }
      ]
    }
  }
}
```

### `expect` and `fatal`

`expect` is the value the field should have: a number, a string for `str` fields, or for integers also a decimal or `0x` string (useful for 64-bit values). A mismatch is recorded as a validation error on the node and parsing continues, with the message `expected X, found Y`.

With `"fatal": true` a mismatch instead fails the field like a read error: the struct stops there, or the `repeat` ends at that element. `fatal` is only valid together with `expect`.

```json
{
  "schemaVersion": 1,
  "id": "expect-demo",
  "name": "Expect",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "magic", "type": "u4", "expect": 1179403647, "fatal": true, "doc": "0x464C457F" },
        { "name": "version", "type": "u2", "expect": "0x0001" },
        { "name": "id", "type": "u8", "expect": "0xFFFFFFFFFFFFFFFF" },
        { "name": "sig", "type": "str", "size": 3, "encoding": "ascii", "expect": "ABC" }
      ]
    }
  }
}
```

### `assert`

A list of 1 to 16 checks run after the field is parsed: `{ "expr", "level"?, "message"? }`. `expr` is a boolean expression in which `_` is the field's value and the field's siblings are visible. `level` is `"error"` (default) or `"warning"`; `message` is up to 500 characters. A failed assert adds a validation message to the node and never stops parsing. An assert that cannot be evaluated adds a warning instead.

```json
{
  "schemaVersion": 1,
  "id": "assert-demo",
  "name": "Assert",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "header_size", "type": "u2" },
        {
          "name": "width",
          "type": "u4",
          "assert": [
            { "expr": "_ > 0", "message": "width is zero" },
            { "expr": "_ <= 65535", "level": "warning", "message": "unusually wide" }
          ]
        }
      ]
    }
  }
}
```

### `doc`

Descriptive text for the field, on the spec, types and bit fields too (up to 20,000 characters). It is plain text, not Markdown: the generated documentation and its Markdown/HTML exports escape it and flatten line breaks, so formatting characters and HTML in a `doc` are shown literally.

## Positioning: `at` and `find`

Fields are sequential by default. Two modifiers place a field elsewhere without moving the parent's cursor. They are mutually exclusive, and `value` fields do not take either.

### `at`

`"at": <number or expression>` is an **absolute** file offset (not relative to the enclosing struct), but it must lie inside the enclosing substream. The next sequential field continues where the cursor was before the `at` field. If a sequential field fails, the rest of the struct's sequential fields are skipped, but fields with `at` still parse, since their position does not depend on the lost cursor.

```json
{
  "schemaVersion": 1,
  "id": "at-demo",
  "name": "Absolute placement",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "table_offset", "type": "u4" },
        { "name": "table_count", "type": "u2" },
        { "name": "table", "type": "entry", "at": "table_offset", "repeat": { "count": "table_count" } },
        { "name": "footer", "type": "u4", "at": "_io.size - 4" }
      ]
    },
    "entry": { "fields": [{ "name": "key", "type": "u2" }, { "name": "value", "type": "u2" }] }
  }
}
```

An array placed with `at` is parsed from that offset; its first 1000 elements are parsed when the file opens and the rest on demand (an array with sequential placement is parsed completely to find where it ends).

### `find`

`find` searches a bounded window for a signature and places the field at the match. It is how end-anchored structures with a variable-length tail are located (ZIP's end-of-central-directory record is the built-in example).

`"find": { "bytes", "mask"?, "from", "window", "direction", "accept"? }`

| Key | Meaning |
|---|---|
| `bytes`, `mask` | Signature as hex (1 to 64 bytes); the mask has the same length and is not all zero. |
| `from` | Expression for the absolute offset the window is measured from. |
| `window` | Window size in bytes, a literal from 1 to 1,048,576. |
| `direction` | `"backward"`: the window is `[from - window, from)`. `"forward"`: it is `[from, from + window)`. The window is clipped to the enclosing stream and a signature must lie wholly inside it. |
| `accept` | 1 to 8 expression strings, the acceptance tiers. |

Candidates are tried nearest to `from` first. Without `accept` the nearest candidate wins. With `accept`, each candidate is trial-parsed as the field's own type and the tiers are tried in order; the first candidate that a tier accepts wins. In `accept` expressions you can use the fields of the field's own type (as parsed at that candidate), `_start`, `_io` and `_parent`. An expression that fails or is not boolean rejects the candidate. If nothing is found (or accepted) the field is an error, as for a failed `at`. When several signatures match, a warning notes how many others were found.

`find` cannot be combined with `at` or `repeat`.

```json
{
  "schemaVersion": 1,
  "id": "find-demo",
  "name": "Signature search",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        {
          "name": "eocd",
          "type": "eocd",
          "find": {
            "bytes": "50 4B 05 06",
            "from": "_io.size",
            "window": 65557,
            "direction": "backward",
            "accept": ["comment_len == _io.size - (_start + 22)", "true"]
          },
          "doc": "Prefer a record whose comment ends exactly at the end of the file, otherwise take the nearest."
        }
      ]
    },
    "eocd": {
      "fields": [
        { "name": "sig", "type": "u4", "expect": 101010256 },
        { "name": "fixed", "type": "bytes", "size": 16 },
        { "name": "comment_len", "type": "u2" }
      ]
    }
  }
}
```

## Guards: `if` and `ifMagic`

A guard makes a field conditional. A field skipped by a guard is not parsed and reads as `null` in expressions. When both are present both must pass, and `if` is evaluated first.

- `"if": <boolean expression>`. An expression that cannot be evaluated is reported on the field; it does not stop the struct.
- `"ifMagic": { "at", "bytes", "mask"? }` tests bytes in the file: `at` is an expression for the absolute offset, `bytes` and `mask` are as in `find` (up to 64 bytes). It is a quiet guard: a position that is negative, unsafe, `null`, outside the enclosing stream, or bytes that cannot be read all mean "no".

```json
{
  "schemaVersion": 1,
  "id": "guard-demo",
  "name": "Guards",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "flags", "type": "u1" },
        { "name": "extra", "type": "u4", "if": "flags & 1 == 1", "doc": "Present only when bit 0 of flags is set." },
        { "name": "count", "type": "u2" },
        {
          "name": "trailer",
          "type": "trailer",
          "at": "_io.size - 4",
          "ifMagic": { "at": "_io.size - 4", "bytes": "54 52 4C 52" }
        }
      ]
    },
    "trailer": { "fields": [{ "name": "sig", "type": "u4" }] }
  }
}
```

## Computed fields: `value`

`{ "type": "value", "value": "<expression>" }` consumes no bytes and defines a name that later expressions can use: an integer, string, boolean, struct or `null`. It appears in the tree as a zero-size node at the current cursor. An expression error is shown on that node and the value becomes `null`; it never fails the struct. `if`, `ifMagic`, `assert` and `ref` work on it; `size`, `repeat`, `at`, `find`, `terminator`, `encoding`, `enum`, `bits`, `expect` and `fatal` do not.

```json
{
  "schemaVersion": 1,
  "id": "value-demo",
  "name": "Computed values",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "kind", "type": "u1" },
        { "name": "count", "type": "u2" },
        { "name": "total", "type": "value", "value": "count * 4 + 8", "doc": "Size of the table below." },
        { "name": "label", "type": "value", "value": "kind == 1 ? \"text\" : \"other\"" },
        { "name": "table", "type": "bytes", "size": "total - 8" }
      ]
    }
  }
}
```

## Deferred pointers and links: `ref`, `jumps`, `link`

Specs often hold offsets to data that is not part of the sequential layout. Two modifiers let the user reach those targets without the engine following anything automatically.

### `ref`: parse a type at an offset on demand

`"ref": { "type", "at", "doc"?, "jumps"? }` on any field (not together with `repeat`). While the file is parsed, `at` is evaluated (`_` is the field's value); if it is a safe offset no larger than the file size, the node records "open `<type>` at 0x..." and nothing is parsed. When the user opens it in the structure tree, `type` (a user type) is parsed at that offset over the whole file, so it may lie outside the substream the ref was found in. In the target, `_parent` is the struct that owns the ref, so target expressions can read the owner's fields. An out-of-range `at` gives a warning and no ref. Opening a ref never opens refs inside the target.

`jumps` (1 to 8 entries `{ "label", "path" }`) adds shortcut buttons to the ref node. Clicking one opens the ref if needed and selects the node at `path`, a dotted chain of field names inside the target type (`data`, `header.extra`; at most 8 segments). The validator checks the path statically: every segment must be a field of the current type, and every segment except the last must be a single (non-repeated) field of a user type, not a switch. If the node at the path was not parsed (for example the field was skipped by `if`), the target is selected and a message says so.

### `link`: a "go to" button for an offset field

`"link": { "at", "size"?, "label"? }` on a field (not together with `repeat`). Nothing is read or parsed. When the field is parsed, `at` and `size` are evaluated in the field's scope (`_` is its value, earlier fields and `_root`/`_parent` are available, later fields are not), and the node gets a button that selects those bytes in the hex view.

- `at` must be a non-negative safe integer inside the file. A `null`, negative, too large or at-or-past-the-end result is a quiet "no link". Only an expression error adds a warning.
- `size` is clamped to the end of the file. If absent or `null`, one byte is selected. A size of 0 only moves the position.
- `label` (up to 100 characters) is the button text; without it the button shows the offset.
- Because a link is evaluated when its field is parsed, it cannot use a value computed later in the file.

```json
{
  "schemaVersion": 1,
  "id": "ref-demo",
  "name": "Refs and links",
  "endian": "le",
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "data_offset", "type": "u4", "link": { "at": "_", "label": "data" } },
        { "name": "count", "type": "u2" },
        { "name": "dir", "type": "dir_entry", "repeat": { "count": "count" } }
      ]
    },
    "dir_entry": {
      "fields": [
        {
          "name": "offset",
          "type": "u4",
          "ref": { "type": "blob", "at": "_", "doc": "The stored blob.", "jumps": [{ "label": "payload", "path": "data" }] }
        },
        { "name": "size", "type": "u4", "link": { "at": "offset", "size": "_", "label": "bytes" } }
      ]
    },
    "blob": {
      "fields": [
        { "name": "header", "type": "u2" },
        { "name": "data", "type": "bytes", "size": "_parent.size" }
      ]
    }
  }
}
```

## Expressions

Expression strings are used in `size`, `at`, `if`, `repeat`, `value`, `assert`, `switch`, `link`, `ref`, `find` and `ifMagic`. Wherever a number is accepted, a plain JSON number also works (it must be a non-negative integer). They are parsed by a hand-written parser and evaluated with checked arithmetic; nothing is ever passed to `eval`.

### Values and literals

- Integers are exact (arbitrary precision internally, capped at +-2^256). Literals: `42`, `0x2A`.
- Floats come from `f4`/`f8` fields and compare with integers numerically.
- Strings: `"text"` with escapes `\n \t \r \0 \" \\ \xNN`. (Inside JSON, double the backslashes and escape the quotes.)
- Booleans `true`, `false`; `null`.
- Structs and arrays, from user-type fields and `repeat` fields. Reach members with `.`.

### Operators

From lowest to highest precedence:

| Level | Operators |
|---|---|
| 1 | `? :` (conditional; short-circuit) |
| 2 | `\|\|` `or` |
| 3 | `&&` `and` |
| 4 | `==` `!=` |
| 5 | `<` `<=` `>` `>=` |
| 6 | `\|` |
| 7 | `^` |
| 8 | `&` |
| 9 | `<<` `>>` |
| 10 | `+` `-` |
| 11 | `*` `/` `%` |
| 12 | unary `-` `~` `!` `not` |

Bitwise operators bind tighter than comparison (as in Python and Rust, not C): `flags & 4 == 4` means `(flags & 4) == 4`. Use parentheses when in doubt.

- `and`, `or`, `not` are the same as `&&`, `||`, `!`. Logical operators and the condition of `?:` need booleans: there is no truthiness, so write `x != 0`, not `x`. `&&`, `||` and `?:` short-circuit, so the unevaluated side may mention things that do not exist.
- `/` and `%` round toward negative infinity (Python and Kaitai behaviour); dividing by zero is an error.
- `~x` is `-x - 1` without a fixed width; mask with `&` when you want one (`~x & 0xFF`).
- Shift counts must be 0 to 64.
- `+` also joins two strings. Strings compare lexicographically; booleans only support `==` and `!=`.
- Results beyond +-2^256 are an error.

### Null

A field that was skipped by `if`/`ifMagic` or failed reads as `null`. Reading a member of `null`, of a raw-bytes field, or a member the struct does not have, gives `null` instead of an error. `==` and `!=` work with `null`; arithmetic and ordering (`<` and the like) on `null` are errors for that one expression.

```text
dib.body.size_image != null ? dib.body.size_image : 0
```

### Functions

| Function | Meaning |
|---|---|
| `min(a, b, ...)`, `max(a, b, ...)` | Smallest or largest of 1 to 8 integers. |
| `lookup(list, "member", value)` | The first element (a struct) of the array `list` whose `member` equals `value` (same equality as `==`), or `null`. `member` must be a string literal. |

`lookup` searches only the elements the engine kept in memory: arrays are parsed eagerly up to 1000 elements, so later (lazy or skimmed) elements are not searched. A single parse may examine up to 5,000,000 elements across all lookups.

### Names

Inside an expression you can use:

| Name | Meaning |
|---|---|
| a field name | A field of the current type that was parsed earlier. A name that is not a field of the type and not one of the names below is a validation error. |
| `field.member` | A member of a struct field; checked at load time when the type is known statically. |
| `_` | The field's own value in `assert`, `until`, `link` and `ref.at`. |
| `_index` | The element index inside a `repeat`. |
| `_parent` | The struct that contains the current one; chain it (`_parent._parent.x`). Past the root it reads as `null`. |
| `_root` | The root struct. |
| `_start` | The absolute offset where the current struct begins; also as a member (`eocd._start`). |
| `_io.size`, `_io.start`, `_io.end` | Size, absolute start and absolute end of the current substream. |
| `_io.pos` | The parent cursor (absolute). |
| `_io.eof` | Whether the cursor is at the end of the substream. |

`_io.pos` and `_io.eof` are errors after an earlier sequential field in the same struct has failed (the cursor is no longer known).

### Expression limits

At most 1024 characters, nesting depth 64 and 512 tokens per expression, and at most 8 function arguments.

## Limits

Spec limits (a spec that exceeds them is rejected with a JSON path such as `$.types.file.fields[2].size`; at most 200 errors are listed):

| Limit | Value |
|---|---|
| Spec size | 1 MiB (1,048,576 bytes) |
| Types per spec | 512 |
| Fields per type | 1024 |
| Fields in total | 20,000 |
| Unconditional type nesting | 32 levels |
| Switch cases per field | 256 |
| Enum entries per enum | 4096 |
| Bit fields per field | 64 |
| `detect` rules | 16 |
| `extensions` | 64 |
| `assert` entries per field | 16 |
| `find.accept` tiers | 8 |
| `ref.jumps` per ref | 8 |
| `find.window` | 1,048,576 |
| Signature (`detect`, `find`, `ifMagic`) | 64 bytes |

Two rules authors run into often:

- **Type cycles.** A type may contain itself (directly or through other types) only if some field on the cycle has `size`, `at`, `find`, `if`, `ifMagic` or `repeat`. Otherwise the validator reports a cycle.
- **Unknown names.** An expression that mentions a name that is neither a field of its type nor one of the context names above is an error at load time, not at parse time.

Parse budgets (the engine stops a parse that exceeds them and shows a partial tree with a message; they are not configurable from a spec): about 100,000 retained nodes, 64 levels of user-type nesting, 2,000,000 steps, 256 MiB of file reads and 1,000,000 read calls per parse. See [`DESIGN.md`](DESIGN.md) for the complete list and how arrays, refs and probes are charged.

## Not supported

The engine does not implement, and has no plans to add:

- relative/pointer sugar (`rel`, `ptr`),
- `align`,
- TLV `chunks`,
- `scanBackFrom`.

Their effects are expressed with `at`, `find`, `switch` and `repeat`. Decompression, decryption and checksum verification are not part of the language either (the built-in ZIP spec reads structure only). Because unknown keys are rejected, other Kaitai Struct features (`instances`, `params`, `process`, imports) cannot be used.
