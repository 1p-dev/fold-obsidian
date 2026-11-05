# Fold memory

An Obsidian plugin that keeps a copy of a Fold memory space's notes in your vault, so you can read, search and browse what your agents have learned with Obsidian's graph, backlinks and search. Turn on sending, and your edits and new notes go back to Fold.

It copies a space's notes, the `inbox/` and `managed/` folders, and nothing else: never the space's reference documents or its guidance files.

## What you need

- **Obsidian 1.13.4 or later.** The plugin is built to run on mobile too, but so far it has been tested on desktop only.
- **A 1p account** with access to a Fold memory space.
- **A token.** On 1p's token page, make a personal access token, and copy it. The scope `fold:read` is enough to copy notes. To send your edits too, give it `fold:write`.
- **Fold's address:** the address of Fold's web app, where you sign in. It starts with `https://`.

## Install

1. Make a new vault for the space, since one vault holds one space.
2. Open Settings (the gear at the bottom left), then **Community plugins**.
3. **If you see Exit Restricted mode, select it.** Obsidian keeps community plugins off until you do.
4. Select **Browse**, search for "Fold memory", then select **Install**, then **Enable**.

You can also open [Fold memory in Obsidian's community directory](https://community.obsidian.md/plugins/fold-memory).

To install it by hand instead, put `main.js` and `manifest.json` from the [latest release](https://github.com/1p-dev/fold-obsidian/releases/latest) in the vault's `.obsidian/plugins/fold-memory/` folder, then enable it under Community plugins. On macOS and Linux, `.obsidian` is hidden: show hidden files to see it.

## Connect a space

1. In Settings, select **Fold memory** in the sidebar, under Community plugins.
2. Paste Fold's address into **Fold address**.
3. Under **Token**, select **Select secret**, then **Add secret...**. Give it an ID such as `fold`, paste your token as the **Secret**, and add it. Obsidian keeps the token in its own secret storage.
4. Under **Space**, choose the space.

The notes then arrive, and the status bar at the bottom shows how many the vault holds.

The address, the token's name, the chosen space and whether sending is on are kept on this device only, never in the vault. A vault can be synced or shared, so nothing in it ever decides where your token goes, what it reads or what it sends. On another device, you enter them again.

## Use it

- **Read the notes** in `managed/`, the notes Fold has filed, and `inbox/`, new notes waiting to be filed. Browse them as you would any notes, with search, links, backlinks and the graph view.
- **Get changes now** with the ribbon's sync button, or "Fold memory: Sync notes now" in the command palette. Otherwise the plugin checks every 5 minutes.
- **To change the notes,** turn on **Send edits to Fold** in the plugin's settings. Until you do, notes open for reading, and an edit stays in this vault.

## Send your edits to Fold

With **Send edits to Fold** on:

- **Edit a copied note,** and the edit goes to Fold a minute after you stop, or at once when you run "Sync notes now". This needs edit access to the space.
- **Write a new note in `inbox/`,** and it is saved to the space's inbox at the same path, for Fold to file like any other note. Contribute access is enough for this. The plugin makes an empty `inbox/` folder if the vault has none.
- **If the note changed in Fold meanwhile,** Fold refuses your edit. Fold's version comes in, and your edit is kept beside it as `name (local edit).md`, so you can bring it across.
- **If Fold refuses a note,** for example because your access is not enough or the note seems to hold a password, the plugin says why. It does not send that note again until you change it, or run "Sync notes now".
- **Only what you change after turning it on is sent.** Earlier edits stay here. A new note is sent only if you make it here after turning sending on: a file the vault already had stays here, even if you change it.
- **Deleting or renaming a note here never reaches Fold,** and the note comes back from Fold. A new note in `managed/` stays here, since Fold files notes there itself. If Obsidian updates links when you rename a note, the notes it changes count as your edits.
- **An edit to a note in `managed/`** reaches Fold only where Fold accepts edits to managed notes. Otherwise Fold refuses it, the plugin says why, and your edit stays here.

## What it does

- **Checks for changes** every 5 minutes while Obsidian is open, and whenever you run "Sync notes now" from the command palette or the ribbon. You can choose every minute, 15 minutes or hour instead. Checking reads no notes, and a sync reads only the notes that changed.
- **Waits for Fold to index a note.** A new or changed note arrives once Fold has indexed it, and the status bar counts the notes still waiting.
- **Copies each note exactly,** checked against Fold's content hash before it is written.
- **Moves a note Fold removed to the trash** your Obsidian settings choose. If Fold removes more than 20 notes at once, and more than the space still has, the plugin leaves them in the vault and tells you. "Sync notes now" then takes them away.
- **Opens a copied note for reading,** unless sending is on, since otherwise an edit would not reach Fold.

## What it never does

- **It never overwrites your own file.** If a file of yours is already where a note would go, that note does not come, and the plugin tells you. A file that already holds exactly the note's text is taken as that note.
- **It never loses your edit.** If you edit a copied note and Fold's version then changes, your edit is kept beside it as `name (local edit).md`. If Fold removes a note you edited, or refuses your edit, your copy stays.
- **It never mixes two spaces.** To choose another space, disconnect first: the notes stay, and are no longer updated, and edits waiting to be sent are dropped. Use a new vault to start clean.
- **It never deletes, renames or moves anything in Fold.**
- **It never touches anything else in the vault,** apart from the empty `inbox/` folder it makes when sending is on.
- **It never writes a path it does not trust,** such as one inside `.obsidian/`, or a name Windows cannot hold.

## Before you use it on a shared space

Notes are what other people and agents wrote. Obsidian does not run scripts in a note, but some plugins do: Dataview's JavaScript queries run a `dataviewjs` block in a note, and Templater can run a note's template code. Keep such plugins off in a vault that holds a space you do not fully trust.

With sending on, what you write goes to the space, where its agents and the people who share it read it. If another sync tool, such as Obsidian Sync, brings changes into the vault, they count as your edits and are sent with your token.

A copy stays on your disk after your access to a space ends. The plugin stops updating it, and the notes remain.

## Keep the address as Fold gives it

Obsidian's network requests follow a redirect to another host and carry your token with them, and a plugin cannot stop that. Fold never redirects, so enter Fold's address exactly, never an address that forwards somewhere else.

The plugin reads Fold's two addresses, one for reading and one for writing, from the web app's settings at `/config.json`, without your token. Fold's query address, which version 0.1 asked for, still works, but only for copying.

## Network use, accounts and privacy

- **Network:** the plugin talks only to Fold. It reads the web app's settings without your token, then lists a space's notes and reads the ones that changed. With sending on, it also sends your edits and new notes to Fold. It contacts nothing else.
- **Account:** it needs a 1p account with access to a Fold memory space, and a personal access token from that account.
- **Telemetry:** none.

## Developing

`pnpm install`, then `pnpm test` runs the unit tests and `pnpm build` writes `dist/main.js` and `dist/manifest.json`.

From 0.1.1, GitHub Actions builds each release from its tag and attests what it built. To check that a release's `main.js` came from this repository: `gh attestation verify main.js --repo 1p-dev/fold-obsidian`.

## Licence

MIT. See [LICENSE](LICENSE).
