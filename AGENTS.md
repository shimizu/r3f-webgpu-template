# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Vite-based React Three Fiber template. Application code lives in `src/`: `main.jsx` boots React, `App.jsx` owns the canvas shell, `Scene.jsx` contains the 3D scene, and `App.css` holds global styling. Static entry files such as `index.html` and `vite.config.js` sit at the root. Reference notes and migration docs live in `reference/` and should be treated as supporting material, not runtime code.

## Build, Test, and Development Commands
Use npm with the existing lockfile.

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: start the Vite dev server for local iteration.
- `npm run build`: create a production bundle in `dist/`.
- `npm run preview`: serve the built app locally to verify the production output.
- `npm run lint`: run ESLint across the project.

Run `npm run lint` before opening a PR. For rendering changes, also verify the scene manually in `npm run dev`.

## Coding Style & Naming Conventions
The codebase uses ES modules, React JSX, and ESLint via [`eslint.config.js`](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/eslint.config.js). Follow the existing style:

- Use 2-space indentation.
- Prefer single quotes in JS/JSX.
- Name React components in `PascalCase` (`Scene`, `App`).
- Use concise camelCase for variables, refs, and helpers.
- Keep scene-specific logic inside `src/Scene.jsx` or split it into focused components under `src/` as the scene grows.

Avoid unused imports and dead shader code; ESLint will flag common issues.

## Testing Guidelines
There is no automated test suite configured yet. Until one is added, treat linting and manual verification as the required quality gate:

- Run `npm run lint`.
- Check the app in `npm run dev`.
- Confirm `npm run build` succeeds for dependency or rendering changes.

If you add tests later, place them beside the module under test or in a `src/__tests__/` directory and use `*.test.jsx` naming.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `update libs`. Keep commits focused and descriptive, for example `add bloom controls` or `refactor scene lighting`.

PRs should include:

- a short summary of behavior changes,
- linked issues when applicable,
- screenshots or a short screen recording for visible scene changes,
- confirmation that `npm run lint` and `npm run build` passed.

## Agent-Specific Instructions
Primary contributors are Japanese developers. Write developer-facing responses, reviews, progress updates, and repository guidance in Japanese unless a task explicitly requires another language. Keep code, filenames, commands, and API identifiers unchanged.
