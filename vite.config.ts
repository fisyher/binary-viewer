/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// base './' so the build works under a GitHub Pages subpath.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(gitCommit()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  // Under Vitest, resolve Svelte's browser build so components can mount (jsdom).
  resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
}));
