# ADR-0001: Fully client-side static app hosted on GitHub Pages

## Status

Accepted

## Date

2026-10-30 (client-side architecture); 2026-10-31 (GitHub Pages deployment)

## Context

The requirement (`requirements/2026-10-30_135401.md`) asks for a fully client-side web application that can run locally or on a static web server. Its stated reason is that the app can then be hosted on GitHub Pages "without the need to host backend services and databases". Built format specs and documentation are to be saved in a local folder.

## Decision

Binary Viewer is a static site: all reading, parsing, editing and saving happens in the browser, and there is no backend. `npm run build` emits a static `dist/` that uses relative asset paths (`base: './'` in `vite.config.ts`), so it works from any subpath.

Hosting is GitHub Pages. Changes reach `main` through pull requests. `.github/workflows/ci.yml` runs on every pull request into `main`: type checks, unit tests, and the Playwright end-to-end suite against the production build. `.github/workflows/deploy.yml` runs on every push to `main` (and by hand): it runs the same CI workflow, then force-pushes the `dist/` that CI built and tested as a single commit to the `gh-pages` branch, which Pages serves. Deployment was added in `1e582e5` ("Deploy to GitHub Pages from the gh-pages branch") and split into pull-request CI plus deploy on 2026-11-01.

## Alternatives considered

- A backend service for parsing or storage. The requirement rules this out for now; the commit history records no other backend design.
- Other hosting. No alternative is recorded; the requirement names GitHub Pages.

## Consequences

- Files are read through the browser's `File`/`Blob` APIs and never uploaded; see [ADR-0009](0009-no-network-requests.md).
- Features that need disk access depend on browser APIs. The File System Access API exists only in Chromium, so a fallback path (download, JSON import/export) must be built and tested alongside it ([ADR-0006](0006-editing-piece-table-and-save.md), [ADR-0008](0008-spec-storage-indexeddb-and-folder-sync.md)).
- A deployment publishes only if type checking, the unit tests and the end-to-end tests pass, and it publishes exactly the build those tests ran against.
