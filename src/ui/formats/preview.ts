/** Shared by App (which owns the engine) and the preview pane. */

/** The host cannot run a draft parse right now (no document, a save in progress, or another engine operation running). The pane waits for its next trigger. */
export class PreviewUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PreviewUnavailableError';
  }
}

export const PREVIEW_DEBOUNCE_MS = 500;
