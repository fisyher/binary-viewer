/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// base './' so the build works under a GitHub Pages subpath.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [svelte()],
  // Under Vitest, resolve Svelte's browser build so components can mount (jsdom).
  resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
}));
