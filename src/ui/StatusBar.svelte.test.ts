// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatusBar from './StatusBar.svelte';

afterEach(cleanup);

describe('StatusBar messages', () => {
  const long = 'Read failed: ' + 'x'.repeat(500);

  it('a long read error is clipped but keeps its full text as the title, and Retry stays reachable outside it', async () => {
    const onRetry = vi.fn();
    const { container, getByRole } = render(StatusBar, { selection: null, error: long, onRetry });
    const err = container.querySelector('.seg.error')!;
    expect(err.classList.contains('text')).toBe(true); // the shrinkable, ellipsised segment
    expect(err.getAttribute('title')).toBe(long);
    const retry = getByRole('button', { name: 'Retry' });
    expect(err.contains(retry)).toBe(false);
    expect(retry.classList.contains('retry')).toBe(true);
    await fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('notices and info carry their full text as the title', () => {
    const { container } = render(StatusBar, { selection: null, notice: long, info: 'Download started' });
    expect(container.querySelector('.seg.error')!.getAttribute('title')).toBe(long);
    expect(container.querySelector('.seg.info')!.getAttribute('title')).toBe('Download started');
  });
});
