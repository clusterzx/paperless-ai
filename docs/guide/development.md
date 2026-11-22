# Development

← [Documentation](README.md)

Requirements: Node.js ≥ 22.12.

```bash
npm install
npm run dev          # backend (tsx watch, port 3000) + web UI (Vite, port 5173)
npm run demo         # demo with a fake Paperless-ngx and a fake LLM: http://127.0.0.1:3456 (admin / demo1234)
npm run check        # typecheck + lint + unit/integration tests
npm run test:e2e     # Playwright end-to-end tests (uses the demo server)
npm run test:e2e:builtin   # end-to-end tests of the built-in archive
# compatibility check against a real (disposable!) Paperless-ngx instance:
PAPERLESS_URL=http://localhost:8000 PAPERLESS_TOKEN=… npx tsx e2e/real-paperless-check.ts
npm run build && npm start
```

- Architecture overview: [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- Design of the built-in archive: [docs/standalone](../standalone/README.md)

## Contributing

Pull requests are welcome! Please run `npm run check` before submitting.
