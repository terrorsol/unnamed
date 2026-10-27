import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'process', 'stream', 'util', 'events'], globals: { Buffer: true, process: true } })],
  define: { 'process.env': {} },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
})
