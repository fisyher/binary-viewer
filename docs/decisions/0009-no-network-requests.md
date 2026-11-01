# ADR-0009: The app makes no network requests at runtime

## Status

Accepted

## Date

2026-10-31

## Context

The tool opens arbitrary binary files, which can be private. The app is static ([ADR-0001](0001-client-side-static-app.md)), so nothing in the architecture needs a server after the page has loaded.

## Decision

The app makes no network requests of its own and has no analytics; files, their contents and metadata are not sent anywhere. This is stated to users in the About dialog (commit `004ac71`: "No network requests of its own and no analytics") and in the README, which calls it a design rule: new features must work offline and must not send file contents or metadata anywhere. HTML documentation exported from a spec embeds a Content-Security-Policy (`default-src 'none'; style-src 'unsafe-inline'`), so an exported page cannot load scripts or fetch resources.

## Alternatives considered

None recorded.

## Consequences

- Features that would need a service (telemetry, remote format catalogues, server-side parsing) are out of scope unless this decision is revisited.
- Sharing specs happens through JSON export/import or a user-chosen local folder ([ADR-0008](0008-spec-storage-indexeddb-and-folder-sync.md)).
- The decision is enforced by convention and review; no automated check for a new `fetch` call was found in the repository.
