import { defineConfig } from 'vite'

// The browser half is built as CommonJS: the generated artifact is wrapped
// into `window.__ModuleLoader__.load({ factory(require) { ... } })` by
// scripts/build.mjs, so `require('react')` resolves through the host loader.
export default defineConfig({
  esbuild: {
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: {
      entry: 'src/client/entry.tsx',
      formats: ['cjs'],
      fileName: () => 'client.cjs',
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        exports: 'named',
        interop: 'auto',
      },
    },
  },
})
