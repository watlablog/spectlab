import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // Prevent tiny JS assets (AudioWorklet modules) from being inlined as data: URLs.
    assetsInlineLimit: 0,
  },
})
