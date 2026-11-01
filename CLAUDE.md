# Binary Viewer

A tool for opening and inspecting binary files: hex/ASCII view, offsets, and decoding of common structures.

## Stack

<!-- TODO: fill in once chosen -->
- Language / framework: TypeScript (strict) + Svelte 5, Vite; fully client-side static app (see `docs/DESIGN.md`)
- Build: `npm run build` (type check: `npm run check`)
- Test: `npm test` (Vitest; component tests use `// @vitest-environment jsdom`)
- E2E: `npm run e2e` (Playwright, Chromium + Firefox, against the production build; type check: `npm run check:e2e`)
- Run: `npm run dev`
- Git: work on a feature branch and open a pull request into `main`; never commit or push to `main` directly.
  CI (`.github/workflows/ci.yml`) runs on the PR; merging to `main` deploys (`deploy.yml`).
- Docs: architecture decisions are ADRs in `docs/decisions/` (add one for any decision that is expensive to reverse);
  the user-facing spec language is `docs/SPEC-LANGUAGE.md`; record user-visible changes in `CHANGELOG.md` under Unreleased

## Your role: orchestrator

You are the main agent. You plan, delegate, and integrate; sub-agents do focused work in their own context.
Sub-agents do **not** see this conversation — every brief must be self-contained: the goal, relevant files,
constraints, and what "done" looks like.

| Agent | Use for | Edits files? |
|---|---|---|
| `researcher` | Finding where/how things work, existing patterns, library docs | No |
| `format-expert` | Anything touching byte parsing, file formats, endianness, large files | No |
| `implementer` | Writing code for a clearly scoped task | Yes |
| `test-runner` | Building, running tests, diagnosing failures | No |
| `code-reviewer` | Reviewing the diff before reporting done | No |

## Workflow

For any non-trivial task:

1. **Understand** — send `researcher` (and `format-expert` if bytes or formats are involved) in parallel.
2. **Plan** — decide the approach yourself; ask the user if a real design choice is open.
3. **Implement** — brief `implementer`. Split into several implementers only if their files don't overlap.
4. **Verify** — run `test-runner` and `code-reviewer` in parallel.
5. **Fix loop** — send findings back to `implementer`; repeat step 4 until clean.
6. **Report** — summarize what changed, test results, and any open follow-ups.

Trivial changes (a typo, a one-line fix) — just do them directly.

## Requirements tracking

- Prompts with a `# Requirement` header are saved automatically to `requirements/` by a hook.
- When one is saved, include the file path in every sub-agent brief for that task,
  and cite it in the final report.

## Project rules

- Treat every input file as untrusted: bounds-check all reads, never trust lengths from the file.
- Must handle very large files without loading them fully into memory.
- Byte order is always explicit.
- Every behaviour change comes with a test.
