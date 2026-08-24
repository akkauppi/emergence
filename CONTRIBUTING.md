# Contributing

Emergence Lab is a small, dependency-free teaching project. Contributions that
make the experiments easier to understand, reproduce, or teach are especially
welcome.

## Development

Install Node.js 20 or newer, then run:

```bash
npm test
npm run check
npm run dev
```

The dev server is available at `http://127.0.0.1:4173`. Keep changes focused,
document user-visible behavior in the README or plan, and add deterministic tests
for simulation rules and state transitions.

## Pull requests

Please describe the teaching question or user problem behind a change, explain
how you tested it, and include screenshots or a short recording for meaningful
visual changes. Avoid adding runtime dependencies unless there is a clear reason.

The `main` branch is deployed automatically to GitHub Pages after a successful
build.
