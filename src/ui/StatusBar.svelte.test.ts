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

describe('StatusBar zoom', () => {
  it('shows nothing at 100%', () => {
    const { container, queryByRole } = render(StatusBar, { selection: null });
    expect(container.querySelector('.zoom')).toBeNull();
    expect(queryByRole('button', { name: /^Zoom/ })).toBeNull();
  });

  it('shows the zoom as a button that resets it when it is not 100%', async () => {
    const onResetZoom = vi.fn();
    const { getByRole, rerender } = render(StatusBar, { selection: null, uiScale: 1.15, onResetZoom });
    const button = getByRole('button', { name: 'Zoom: 115%. Reset to 100%' });
    expect(button.textContent).toBe('115%');
    await fireEvent.click(button);
    expect(onResetZoom).toHaveBeenCalledOnce();
    await rerender({ uiScale: 0.9 });
    expect(getByRole('button', { name: 'Zoom: 90%. Reset to 100%' }).textContent).toBe('90%');
  });
});
