import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api/': 'http://localhost:4317' } },
})
