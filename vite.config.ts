import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/ui'),
  plugins: [viteSingleFile()],
  build: {
    outDir: path.resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/ui/index.html'),
    },
  },
});
