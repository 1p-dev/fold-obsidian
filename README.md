# Fold memory

An Obsidian plugin that keeps a read-only copy of a Fold memory space's notes in your vault, so you can read, search and browse what your agents have learned with Obsidian's graph, backlinks and search.

It copies a space's notes, the `inbox/` and `managed/` folders, and nothing else: never the space's reference documents or its guidance files. It only reads from Fold: an edit you make in the vault never reaches it.

## What you need

- **Obsidian 1.13.4 or later.** The plugin is built to run on mobile too, but so far it has been tested on desktop only.
- **A 1p account** with access to a Fold memory space.
- **A token.** On 1p's token page, make a personal access token with the scope `fold:read`, and copy it. The plugin never writes to Fold, so it needs no more than that.
- **Fold's query address,** which starts with `https://`. If you don't have it, ask 1p.

## Install

1. Make a new vault for the space, since one vault holds one space.
2. Open Settings (the gear at the bottom left), then **Community plugins**.
3. **If you see Exit Restricted mode, select it.** Obsidian keeps community plugins off until you do.
4. Select **Browse**, search for "Fold memory", then select **Install**, then **Enable**.

You can also open [Fold memory in Obsidian's community directory](https://community.obsidian.md/plugins/fold-memory).

To install it by hand instead, put `main.js` and `manifest.json` from the [latest release](https://github.com/1p-dev/fold-obsidian/releases/latest) in the vault's `.obsidian/plugins/fold-memory/` folder, then enable it under Community plugins. On macOS and Linux, `.obsidian` is hidden: show hidden files to see it.

## Connect a space

1. In Settings, select **Fold memory** in the sidebar, under Community plugins.
2. Paste Fold's query address into **Fold query address**.
3. Under **Token**, select **Select secret**, then **Add secret...**. Give it an ID such as `fold`, paste your token as the **Secret**, and add it. Obsidian keeps the token in its own secret storage.
4. Under **Space**, choose the space.

The notes then arrive, and the status bar at the bottom shows how many the vault holds.

The address, the token's name and the chosen space are kept on this device only, never in the vault. A vault can be synced or shared, so nothing in it ever decides where your token goes or what it reads. On another device, you enter them again.

## Use it

- **Read the notes** in `managed/`, the notes Fold has filed, and `inbox/`, new notes waiting to be filed. Browse them as you would any notes, with search, links, backlinks and the graph view.
- **Get changes now** with the ribbon's sync button, or "Fold memory: Sync notes now" in the command palette. Otherwise the plugin checks every 5 minutes.
- **Don't edit the notes.** They open for reading, and an edit stays in this vault: it never reaches Fold. To correct a note, add a new one to the space's inbox through an agent or Fold's web app.

## What it does

- **Checks for changes** every 5 minutes while Obsidian is open, and whenever you run "Sync notes now" from the command palette or the ribbon. You can choose every minute, 15 minutes or hour instead. Checking reads no notes, and a sync reads only the notes that changed.
- **Waits for Fold to index a note.** A new or changed note arrives once Fold has indexed it, and the status bar counts the notes still waiting.
- **Copies each note exactly,** checked against Fold's content hash before it is written.
- **Moves a note Fold removed to the trash** your Obsidian settings choose. If Fold removes more than 20 notes at once, and more than the space still has, the plugin leaves them in the vault and tells you. "Sync notes now" then takes them away.
- **Opens a copied note for reading,** since an edit would not reach Fold.

## What it never does

- **It never overwrites your own file.** If a file of yours is already where a note would go, that note does not come, and the plugin tells you. A file that already holds exactly the note's text is taken as that note.
- **It never loses your edit.** If you edit a copied note and Fold's version then changes, your edit is kept beside it as `name (local edit).md`. If Fold removes a note you edited, your copy stays.
- **It never mixes two spaces.** To choose another space, disconnect first: the notes stay, and are no longer updated. Use a new vault to start clean.
- **It never touches anything else in the vault.**
- **It never writes a path it does not trust,** such as one inside `.obsidian/`, or a name Windows cannot hold.

## Before you use it on a shared space

Notes are what other people and agents wrote. Obsidian does not run scripts in a note, but some plugins do: Dataview's JavaScript queries run a `dataviewjs` block in a note, and Templater can run a note's template code. Keep such plugins off in a vault that holds a space you do not fully trust.

A copy stays on your disk after your access to a space ends. The plugin stops updating it, and the notes remain.

## Keep the address as Fold gives it

Obsidian's network requests follow a redirect to another host and carry your token with them, and a plugin cannot stop that. Fold never redirects, so enter Fold's query address exactly, never an address that forwards somewhere else.

## Network use, accounts and privacy

- **Network:** the plugin talks only to the Fold query address you enter, to list a space's notes and read the ones that changed. It contacts nothing else.
- **Account:** it needs a 1p account with access to a Fold memory space, and a personal access token from that account.
- **Telemetry:** none.

## Developing

`pnpm install`, then `pnpm test` runs the unit tests and `pnpm build` writes `dist/main.js` and `dist/manifest.json`.

From 0.1.1, GitHub Actions builds each release from its tag and attests what it built. To check that a release's `main.js` came from this repository: `gh attestation verify main.js --repo 1p-dev/fold-obsidian`.

## Licence

MIT. See [LICENSE](LICENSE).
