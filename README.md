# Fold memory

An Obsidian plugin that keeps a read-only copy of a Fold memory space's notes in your vault, so you can read, search and browse what your agents have learned with Obsidian's graph, backlinks and search.

It copies a space's notes, the `inbox/` and `managed/` folders, and nothing else: never the space's reference documents or its guidance files. It only reads from Fold. An edit you make in the vault does not reach Fold, so to correct a note, add a new one to the space's inbox through an agent or Fold's web app.

## What you need

- Obsidian 1.11.4 or later. The plugin is built to run on mobile too, but so far it has been tested on desktop only.
- A 1p account with access to a Fold memory space.
- A 1p personal access token with the `fold:read` scope. The plugin never writes to Fold, so it needs no more than that.
- Fold's query address.

## Install

Fold memory is not in Obsidian's community directory yet. To install it by hand:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/1p-dev/fold-obsidian/releases/latest).
2. Make a new vault for the space. One vault holds one space.
3. In the vault's folder, make the folder `.obsidian/plugins/fold-memory/` and put both files in it. On macOS and Linux, `.obsidian` is hidden: show hidden files to see it.
4. In Obsidian, open Settings, then Community plugins. Turn on community plugins, then enable Fold memory.

## Connect a space

1. In Fold memory's settings, enter Fold's query address.
2. Under Token, create a secret and paste your token into it. Obsidian keeps it in its own secret storage.
3. Choose a space.

The notes then arrive, and the status bar shows how many the vault holds.

The address, the token's name and the chosen space are kept on this device only, never in the vault. A vault can be synced or shared, so nothing in it ever decides where your token goes or what it reads. On another device, you enter them again.

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

## Licence

MIT. See [LICENSE](LICENSE).
