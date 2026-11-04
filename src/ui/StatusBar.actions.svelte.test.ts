// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatusBar from './StatusBar.svelte';

afterEach(cleanup);

describe('StatusBar format, parse and actions', () => {
  const sel = { anchor: 2, caret: 5 };

  it('the format is a button named "Format: <name>. Choose format"; "No format" without one', async () => {
    const onChooseFormat = vi.fn();
    const { getByRole, rerender } = render(StatusBar, { selection: null, size: 10, formatName: 'Windows Bitmap', onChooseFormat });
    const btn = getByRole('button', { name: 'Format: Windows Bitmap. Choose format' });
    await fireEvent.click(btn);
    expect(onChooseFormat).toHaveBeenCalledWith(btn);
    await rerender({ selection: null, size: 10, formatName: null, onChooseFormat });
    expect(getByRole('button', { name: 'Format: No format. Choose format' }).textContent?.trim()).toBe('No format');
  });

  it('a weak detection adds a muted "(extension only)" tag and puts the hint in the title and the name', () => {
    const { getByRole } = render(StatusBar, { selection: null, size: 10, formatName: 'Windows Bitmap', formatHint: 'Suggested from extension only' });
    const btn = getByRole('button', { name: 'Format: Windows Bitmap (Suggested from extension only). Choose format' });
    expect(btn.textContent).toContain('(extension only)');
    expect(btn.querySelector('.tag')).not.toBeNull();
    expect(btn.title).toContain('Suggested from extension only');
  });

  it('has no format button without a document', () => {
    const { queryByRole } = render(StatusBar, { selection: null, size: null });
    expect(queryByRole('button', { name: /^Format:/ })).toBeNull();
  });

  it('shows nothing for an idle parse and Parsing… with a visible Cancel while parsing', async () => {
    const onCancelParse = vi.fn();
    const { queryByRole, getByRole, getByText, rerender } = render(StatusBar, { selection: null, size: 10, parse: { state: 'idle' } });
    expect(queryByRole('status')).toBeNull();
    await rerender({ selection: null, size: 10, parse: { state: 'parsing' }, onCancelParse });
    expect(getByRole('status').textContent).toBe('Parsing…');
    expect(getByRole('status').classList.contains('sr-only')).toBe(false); // visible
    expect(getByText('Parsing…')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onCancelParse).toHaveBeenCalledOnce();
  });

  it('a finished parse is a compact button that opens Problems, with the full sentence as the status text', async () => {
    const onShowProblems = vi.fn();
    const { getByRole, container } = render(StatusBar, {
      selection: null,
      size: 10,
      parse: { state: 'done', nodes: 22, errors: 0, warnings: 1 },
      onShowProblems,
    });
    expect(getByRole('status').textContent).toBe('Parsed: 22 nodes, 0 errors, 1 warnings');
    expect(getByRole('status').classList.contains('sr-only')).toBe(true); // read, not shown twice
    const summary = getByRole('button', { name: 'Show problems: 0 errors, 1 warning' });
    expect(summary.textContent?.replace(/\s+/g, ' ').trim()).toBe('22 nodes · 0 errors · 1 warning');
    expect(summary.title).toBe('Parsed: 22 nodes, 0 errors, 1 warnings. Show problems');
    expect(container.querySelector('.summary .nodes')).not.toBeNull(); // the node count is its own part: hidden under 720px
    await fireEvent.click(summary);
    expect(onShowProblems).toHaveBeenCalledOnce();
  });

  it('Truncated and Aborted show a short lead and keep the full text in the title', async () => {
    const { getByRole, rerender } = render(StatusBar, { selection: null, size: 10, parse: { state: 'truncated', nodes: 100000, errors: 0, warnings: 0 } });
    const summary = () => getByRole('button', { name: /^Show problems/ });
    expect(summary().querySelector('.lead')?.textContent).toBe('Truncated');
    expect(summary().title).toMatch(/^Truncated \(limit reached, partial tree\): 100000 nodes/);
    await rerender({ selection: null, size: 10, parse: { state: 'aborted', nodes: 3, errors: 1, warnings: 0 } });
    expect(summary().querySelector('.lead')?.textContent).toBe('Aborted');
    expect(summary().getAttribute('aria-label')).toBe('Show problems: 1 error, 0 warnings');
  });

  it('a failed parse shows its message in the status element, clipped with a title, and has no Problems button', () => {
    const msg = 'Parse failed: ' + 'x'.repeat(300);
    const { getByRole, queryByRole } = render(StatusBar, { selection: null, size: 10, parse: { state: 'error', message: msg } });
    expect(getByRole('status').getAttribute('title')).toBe(msg);
    expect(getByRole('status').classList.contains('text')).toBe(true);
    expect(queryByRole('button', { name: /^Show problems/ })).toBeNull();
  });

  it('an engine error is an alert with its full text as the title, in the error style', () => {
    const { getByRole } = render(StatusBar, { selection: null, size: 10, engineError: 'Format engine unavailable: boom' });
    const alert = getByRole('alert');
    expect(alert.getAttribute('title')).toBe('Format engine unavailable: boom');
    expect(alert.classList.contains('error')).toBe(true);
    expect(alert.classList.contains('text')).toBe(true);
  });

  it('the selection item is a button for Go to offset (disabled without a non-empty file)', async () => {
    const onGoTo = vi.fn();
    const { getByRole, rerender } = render(StatusBar, { selection: sel, size: 10, canGoTo: true, onGoTo });
    const item = getByRole('button', { name: /Start: 0x2 \(2\)/ });
    expect(item.textContent).toContain('End: 0x5 (5)');
    expect(item.textContent).toContain('Length: 0x4 (4)');
    await fireEvent.click(item);
    expect(onGoTo).toHaveBeenCalledWith(item);
    await rerender({ selection: null, size: 10, canGoTo: false, onGoTo });
    expect((getByRole('button', { name: /No selection/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the edit mode item is a button with a descriptive name and no aria-pressed', async () => {
    const onToggleInsert = vi.fn();
    const { getByRole, rerender, queryByRole } = render(StatusBar, { selection: null, size: 10, insertMode: false, onToggleInsert });
    const btn = getByRole('button', { name: 'Edit mode: Overwrite. Switch to insert' });
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
    expect(btn.title).toBe('Press Insert to toggle');
    await fireEvent.click(btn);
    expect(onToggleInsert).toHaveBeenCalledOnce();
    await rerender({ selection: null, size: 10, insertMode: true, onToggleInsert });
    expect(getByRole('button', { name: 'Edit mode: Insert. Switch to overwrite' }).textContent).toBe('Insert');
    await rerender({ selection: null, size: 10, insertMode: null });
    expect(queryByRole('button', { name: /^Edit mode/ })).toBeNull();
  });

  it('is the status region, with a button for each action', () => {
    const { container } = render(StatusBar, { selection: sel, size: 10, formatName: 'X', insertMode: false, parse: { state: 'done', nodes: 1, errors: 0, warnings: 0 }, canGoTo: true });
    expect(container.querySelector('footer')!.getAttribute('data-region')).toBe('status');
    expect(container.querySelectorAll('footer.status button').length).toBeGreaterThanOrEqual(6); // format, byte order, selection, mode, summary, theme
  });
});
