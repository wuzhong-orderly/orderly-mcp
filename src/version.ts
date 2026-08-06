// The `__APP_VERSION__` identifier is injected at build time by esbuild's
// `define` (see scripts/build.js), sourced from package.json. The `typeof`
// guard keeps the module safe to import under `tsc --noEmit` and any
// non-esbuild execution path, falling back to a dev sentinel.
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
