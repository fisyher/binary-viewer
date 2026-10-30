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
