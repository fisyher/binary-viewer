// Injected by vite.config.ts `define`.
declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_DATE__: string;

// vite.config.ts uses these two Node modules; @types/node is not a dependency, so declare just what it needs.
declare module 'node:child_process' {
  export function execSync(command: string, options?: { cwd?: string; stdio?: string[] }): { toString(): string };
}
declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
