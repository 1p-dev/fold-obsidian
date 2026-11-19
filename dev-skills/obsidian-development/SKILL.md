# Obsidian development

- **Only `main.ts`, `settings.ts`, `link-modal.ts` and `vault-store.ts` import `obsidian`** (the tests mock it). Keep the rest free of it, so the tests reach it without Obsidian.
