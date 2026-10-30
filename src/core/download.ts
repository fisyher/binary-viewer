/**
 * Offer a Blob as a file download. The object URL is revoked only after a delay: revoking right after click()
 * breaks downloads in Firefox. `fileName` must be a safe name chosen by the caller (spec ids are validated).
 */
export function downloadBlob(fileName: string, blob: Blob, revokeDelayMs = 10_000): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
  }
}
