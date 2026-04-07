# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the application code. Entry points are `src/main.jsx` and `src/App.jsx`; `src/Scene.jsx` composes the 3D scene. Keep reusable scene pieces in `src/layers/`, postprocessing in `src/effects/`, GPU compute helpers in `src/compute/`, GIS utilities in `src/gis/`, and sample data in `src/data/`. Static assets live under `public/`, including `public/data/` for GeoJSON and `public/dem/` or `public/textures/` for terrain and material inputs. Reference notes and design writeups belong in `docs/`.

## Build, Test, and Development Commands
Use `npm install` to install dependencies from `package-lock.json`. Run `npm run dev` to start the Vite dev server. Run `npm run build` to create a production bundle in `dist/`. Run `npm run preview` to serve the built output locally for a quick production check. There is no dedicated lint script yet; use `npx eslint .` before opening a PR.

## Coding Style & Naming Conventions
This project uses ES modules, React function components, and JSX. Preserve the existing style: no semicolons, single quotes, and straightforward module structure. Name React components and scene layers in PascalCase (`WaterOceanLayer.jsx`), helper modules in camelCase (`createBloom.js`), and colocate related files by feature. Keep Three.js and React Three Fiber props explicit rather than heavily abstracted; this codebase favors readable scene composition over dense helper wrappers.

## Testing Guidelines
There is currently no automated test suite. For changes, verify the relevant scene in `npm run dev`, then run `npm run build` to catch bundling errors. If you add tests, keep them near the feature or under a future `tests/` directory, and use filenames ending in `.test.jsx` or `.test.js`.

## Commit & Pull Request Guidelines
Recent history follows short, imperative subjects, often with prefixes such as `feat:`, `fix:`, `refactor:`, or `docs:`. Keep commits focused and scoped to one concern. PRs should include a brief summary, note any asset or data changes, link related issues, and attach screenshots or short recordings for visual scene updates.

## Assets & Configuration Tips
Large DEM, GeoTIFF, and texture assets already live in `public/`; avoid duplicating heavy files unless needed. Prefer referencing assets by stable public paths such as `/data/world.geojson` or `/textures/waternormals.jpg`.

## Communication
Contributors and agents should respond to the repository owner in Japanese. Keep explanations concise, technical, and action-oriented, and use English only when required for code, commands, file paths, or external API names.
