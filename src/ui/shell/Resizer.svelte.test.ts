// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Resizer from './Resizer.svelte';
import { visualScale } from './zoom';

afterEach(cleanup);

const props = () => ({ orientation: 'vertical' as const, value: 300, min: 200, max: 600, label: 'Resize side bar', onResize: vi.fn(), onReset: vi.fn() });

describe('Resizer', () => {
  it('has no menu and does not claim the context menu when it is not given Reset layout', async () => {
    const { getByRole, queryByRole } = render(Resizer, props());
    const bar = getByRole('separator');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    bar.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(queryByRole('menu')).toBeNull();
  });

  describe('with a Reset layout action', () => {
    const mount = () => {
      const onResetLayout = vi.fn();
      const r = render(Resizer, { ...props(), onResetLayout });
      return { ...r, onResetLayout, bar: r.getByRole('separator') };
    };

    it('right-click opens a menu with the single item "Reset layout" and moves focus into it', async () => {
      const { bar, getByRole, getAllByRole } = mount();
      await fireEvent.contextMenu(bar, { clientX: 10, clientY: 20 });
      const menu = getByRole('menu');
      expect(menu.getAttribute('aria-label')).toBe('Resize side bar menu');
      expect(getAllByRole('menuitem')).toHaveLength(1);
      await waitFor(() => expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Reset layout' })));
    });

    it('Shift+F10 and the ContextMenu key open it from the keyboard (the page menu is suppressed)', async () => {
      for (const init of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
        const { bar, getByRole, queryByRole, unmount } = mount();
        bar.focus();
        const ev = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        bar.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        await waitFor(() => expect(getByRole('menu')).toBeTruthy());
        expect(queryByRole('menuitem', { name: 'Reset layout' })).not.toBeNull();
        unmount();
      }
    });

    it('plain F10 and other keys do not open it', async () => {
      const { bar, queryByRole } = mount();
      await fireEvent.keyDown(bar, { key: 'F10' });
      await fireEvent.keyDown(bar, { key: 'Enter' });
      expect(queryByRole('menu')).toBeNull();
    });

    it('Escape closes it and focus returns to the resizer', async () => {
      const { bar, getByRole, queryByRole } = mount();
      await fireEvent.contextMenu(bar);
      const item = getByRole('menuitem');
      await waitFor(() => expect(document.activeElement).toBe(item));
      await fireEvent.keyDown(item, { key: 'Escape' });
      expect(queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(bar);
    });

    it('the menu keys are not the resizer keys: an arrow in the menu does not resize', async () => {
      const p = props();
      const { getByRole } = render(Resizer, { ...p, onResetLayout: vi.fn() });
      const bar = getByRole('separator');
      await fireEvent.contextMenu(bar);
      await fireEvent.keyDown(getByRole('menuitem'), { key: 'ArrowRight' });
      expect(p.onResize).not.toHaveBeenCalled();
    });

    it('choosing the item runs the action, closes the menu and returns focus to the resizer', async () => {
      const { bar, getByRole, queryByRole, onResetLayout } = mount();
      await fireEvent.contextMenu(bar);
      await fireEvent.click(getByRole('menuitem', { name: 'Reset layout' }));
      expect(onResetLayout).toHaveBeenCalledOnce();
      expect(queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(bar);
    });

    it('a press elsewhere closes it without stealing focus', async () => {
      const { bar, queryByRole, getByRole } = mount();
      await fireEvent.contextMenu(bar);
      expect(getByRole('menu')).toBeTruthy();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await waitFor(() => expect(queryByRole('menu')).toBeNull());
    });

    it('Tab closes it and puts focus on the divider (the default Tab is prevented: moving on from a vanishing item is unreliable)', async () => {
      const { bar, getByRole, queryByRole } = mount();
      await fireEvent.contextMenu(bar);
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      getByRole('menuitem').dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      await waitFor(() => expect(queryByRole('menu')).toBeNull());
      expect(document.activeElement).toBe(bar);
    });

    it('closes on a window resize, a blur and any scroll', async () => {
      for (const fire of [() => window.dispatchEvent(new Event('resize')), () => window.dispatchEvent(new Event('blur')), () => document.body.dispatchEvent(new Event('scroll'))]) {
        const { bar, getByRole, queryByRole, unmount } = mount();
        await fireEvent.contextMenu(bar);
        expect(getByRole('menu')).toBeTruthy();
        fire();
        await waitFor(() => expect(queryByRole('menu')).toBeNull());
        unmount();
      }
    });

    it('is kept inside the viewport (measured after it is shown, in CSS px under the zoom)', async () => {
      vi.stubGlobal('innerWidth', 500);
      vi.stubGlobal('innerHeight', 400);
      // a 100 x 40 px menu (layout size, in CSS px)
      const sizes = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'menu' ? 100 : 0;
      });
      const heights = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'menu' ? 40 : 0;
      });
      try {
        const { bar, getByRole } = mount();
        await fireEvent.contextMenu(bar, { clientX: 480, clientY: 390 });
        await waitFor(() => expect((getByRole('menu') as HTMLElement).style.left).toBe('400px'));
        expect((getByRole('menu') as HTMLElement).style.top).toBe('360px');
        cleanup();
        document.documentElement.style.setProperty('--ui-scale', '2'); // 2x: screen px are twice the CSS px
        const again = mount();
        await fireEvent.contextMenu(again.bar, { clientX: 400, clientY: 100 }); // CSS 200,50
        const m = again.getByRole('menu') as HTMLElement;
        await waitFor(() => expect(m.style.left).not.toBe(''));
        expect(m.style.left).toBe('150px'); // 100 CSS px = 200 screen px wide: its right edge would be at 600 > 500, so it moves back 100 screen px = 50 CSS px
        expect(m.style.top).toBe('50px');
      } finally {
        sizes.mockRestore();
        heights.mockRestore();
        vi.unstubAllGlobals();
        document.documentElement.style.removeProperty('--ui-scale');
      }
    });

    it('after Reset layout, if the divider is gone, focus goes to the editor region (not to <body>)', async () => {
      const editor = document.createElement('main');
      editor.setAttribute('data-region', 'editor');
      editor.tabIndex = -1;
      document.body.append(editor);
      try {
        let sep: HTMLElement | undefined;
        const onResetLayout = vi.fn(() => sep?.remove()); // the panel closes: the divider leaves the document
        const r = render(Resizer, { ...props(), onResetLayout });
        sep = r.getByRole('separator');
        await fireEvent.contextMenu(sep);
        await fireEvent.click(r.getByRole('menuitem', { name: 'Reset layout' }));
        await waitFor(() => expect(document.activeElement).toBe(editor));
      } finally {
        editor.remove();
      }
    });

    it('keeps the resizer behaviour: arrows resize and double-click resets', async () => {
      const p = props();
      const { getByRole } = render(Resizer, { ...p, onResetLayout: vi.fn() });
      const bar = getByRole('separator');
      await fireEvent.keyDown(bar, { key: 'ArrowRight' });
      expect(p.onResize).toHaveBeenCalledWith(316);
      await fireEvent.dblClick(bar);
      expect(p.onReset).toHaveBeenCalledOnce();
    });
  });
});

describe('Resizer under the UI zoom', () => {
  afterEach(() => document.documentElement.style.removeProperty('--ui-scale'));

  it('a drag of N screen px changes the size by N / zoom', async () => {
    document.documentElement.style.setProperty('--ui-scale', '2');
    const p = props();
    const { getByRole } = render(Resizer, p);
    const bar = getByRole('separator');
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 160 }));
    expect(p.onResize).toHaveBeenLastCalledWith(330); // 60 screen px = 30 CSS px
  });
});

describe('visualScale', () => {
  afterEach(() => document.documentElement.removeAttribute('style'));

  it('is the root zoom (--ui-scale), exactly, not a measured ratio', () => {
    document.documentElement.style.setProperty('--ui-scale', '1.15');
    expect(visualScale()).toBe(1.15);
    document.documentElement.style.setProperty('--ui-scale', '0.9');
    expect(visualScale()).toBe(0.9);
  });

  it('is 1 without a zoom or for a value that is not a sensible number', () => {
    expect(visualScale()).toBe(1);
    for (const v of ['abc', '0', '-2', '40', 'NaN', 'Infinity']) {
      document.documentElement.style.setProperty('--ui-scale', v);
      expect(visualScale(), v).toBe(1);
    }
  });
});
