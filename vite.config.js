import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { createReadStream } from 'fs'
import { resolve } from 'path'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// onnxruntime-web loads these .mjs files via dynamic import() at runtime.
// Vite dev server refuses to serve public/ files as ES modules, so we intercept
// those requests with a middleware that serves them directly from node_modules.
const ortDevPlugin = {
  name: 'ort-wasm-dev',
  apply: 'serve',
  configureServer(server) {
    const files = [
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.asyncify.mjs',
    ]
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split('?')[0]
      const match = files.find(f => url === `/${f}`)
      if (match) {
        res.setHeader('Content-Type', 'text/javascript')
        createReadStream(resolve('node_modules/onnxruntime-web/dist/' + match))
          .on('error', () => res.sendStatus(404))
          .pipe(res)
        return
      }
      next()
    })
  },
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly.
  // This allows the vite server to EXPOSE all interfaces when the host
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)

  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [
      react(),
      ortDevPlugin,
      viteStaticCopy({
        targets: [
          { src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', dest: '.' },
          { src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', dest: '.' },
          { src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', dest: '.' },
          { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', dest: '.' },
          { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', dest: '.' },
          { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', dest: '.' },
          { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', dest: '.' },
        ],
      }),
    ],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      allowedHosts: ['claude-test.catwang.top'],
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
