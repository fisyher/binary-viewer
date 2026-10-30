const ENDIAN_KEY = 'binaryviewer.inspector.endian';

/** Saved inspector byte order; little-endian unless "be" was stored. Storage errors are ignored. */
export function loadLittleEndian(): boolean {
  try {
    return localStorage.getItem(ENDIAN_KEY) !== 'be';
  } catch {
    return true;
  }
}

export function saveLittleEndian(le: boolean): void {
  try {
    localStorage.setItem(ENDIAN_KEY, le ? 'le' : 'be');
  } catch {
    // storage unavailable (private mode, quota, disabled): the choice just won't persist
  }
}

const REWRITE_KEY = 'binaryviewer.builder.hideRewriteNotice';

/** True when the user chose "Don't show again" for the builder's canonical-rewrite notice. Storage errors read as false. */
export function loadHideRewriteNotice(): boolean {
  try {
    return localStorage.getItem(REWRITE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveHideRewriteNotice(): void {
  try {
    localStorage.setItem(REWRITE_KEY, '1');
  } catch {
    // storage unavailable: the notice just shows again next time
  }
}
