import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

/**
 * Nakama loads our runtime by reading a single CommonJS file in `runtime.path`
 * and looking for a top-level `InitModule` function on the Goja VM globals.
 *
 * Constraints:
 *  - Single output file (`dist/index.js`).
 *  - CommonJS format.
 *  - `target: ES2017` — Goja's JS support is solid for ES5/ES6 but quirky on
 *    iterator spread, top-level await, and newer-than-2017 syntax.
 *  - No Node built-ins (`fs`, `path`, `process`) — they don't exist in Goja.
 *  - No async/await inside match handlers (allowed in InitModule but avoid).
 */
export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/index.js',
    format: 'cjs',
    inlineDynamicImports: true,
    sourcemap: false,
  },
  plugins: [
    resolve({
      browser: false,
      preferBuiltins: false,
    }),
    commonjs(),
    json({
      // Inline tilemap JSON (and any other content imports) into the bundle.
      preferConst: true,
      compact: true,
      namedExports: false,
    }),
    typescript({
      tsconfig: './tsconfig.json',
      sourceMap: false,
      inlineSources: false,
      noEmitOnError: true,
    }),
  ],
};
