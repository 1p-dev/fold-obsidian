# fold-obsidian

## Read this first

- This file is for everyone who works on this repo: any agent, any tool, any developer. Keep it true for all of them.
- Keep local information out of it: nothing about one person's machine, paths, accounts or team setup. That belongs in your own tool's settings or memory.
- Do not assume a tool. Some agents reading this will not have the tools others have.

This repo is small enough to work in by reading its files (100 code files or fewer). Decided 19 November 2026; look again only if that clearly changes.

An Obsidian plugin that keeps a copy of a Fold memory space's notes in a vault. Start with [README.md](README.md): what it does, and how to build and test it (under Developing). The sync's rules are stated in the header comment of `src/sync.ts`.

## Rules for every change

- **A script writes most of this repo** from the maintainers' own source: `src/` (with `src/api/`, copied from their web app), `e2e/`, `README.md`, `LICENSE`, `manifest.json`, `package.json`, `tsconfig*.json`, `esbuild.config.mjs`, `versions.json`, `.gitignore` and `.github/workflows/release.yml`. An edit made to them here is overwritten at the next release. Open an issue describing the change, and the maintainers make it at the source. This file, the tool pointer files and `pnpm-lock.yaml` are kept here by hand.
- **Only `main.ts`, `settings.ts`, `link-modal.ts` and `vault-store.ts` import `obsidian`** (the tests mock it). Keep the rest free of it, so the tests reach it without Obsidian.
- **The README's "What it never does" is not for a change to break:** a person's own file is never overwritten, and their edit is never lost. The token goes to the address the person connected, and Obsidian carries it along a redirect, which a plugin cannot stop: so the address is Fold's exact one, never one that forwards (the README's "Keep the address as Fold gives it").
- **Before you finish,** run `pnpm typecheck`, `pnpm test` and `pnpm build`; and `node e2e/run.mjs <obsidian binary>` if you changed anything that calls Obsidian's API (its header says how to get Obsidian).
- **A tag is a release,** offered to everyone who has the plugin, and cannot be taken back. Push a tag only with the owner's go, and never move or delete one that is pushed.
- **A new runtime dependency** travels inside `main.js`: check its licence first. `obsidian` comes from the app and is never bundled.
