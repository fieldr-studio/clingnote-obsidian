# ClingNote for Obsidian

Notes that follow your work. Attach Obsidian notes to the Windows files, folders, apps and web pages you work in, and ClingNote **brings the right note back when you return to that work**.

> **Windows only.** ClingNote needs a small separate Windows program, the **ClingNote companion**, to know which file, app or web page is in front. The plugin never downloads, installs or starts it for you.

## What it does
- **Contexts:** a context is a Windows file, folder, app window or browser page (Chrome, Edge, Brave, Vivaldi). Each context can have a **Main** note and any number of **secondary** notes. One note can belong to several contexts, and notes can stay **unattached**.
- **A native sidebar** lists every context with its notes. Rename contexts, give them an icon, search, collapse, and drag and drop notes to attach, move, re-order or promote a note to Main.
- **Automatic switching (Pro):** when you switch to an attached context, ClingNote opens its Main note. **Pause** or resume following any time; private/incognito browser windows pause it automatically.
- **Your notes are never changed.** Attaching only stores a link inside the plugin's own data. Detaching, or an expired license, never deletes or edits a note.

| | Free | Pro |
|---|---|---|
| Attach notes to contexts, sidebar, search, rename, icons, drag and drop | ✓ | ✓ |
| Manual navigation between attached notes | ✓ | ✓ |
| **Automatic switching** when you change work | – | ✓ |

**Pro** is a **$20 one-time payment** with lifetime access and no subscription (existing monthly and annual licenses keep working). One license also unlocks **ClingNote for Windows** and works on **up to four activations** shared across both apps. A **14-day free trial** of Pro is available, one per computer (shared with ClingNote for Windows); it starts only when you press *Start trial*. No card needed.

## Requirements
- Windows 10 or 11 (64-bit) and **Obsidian 1.14.4 or newer** (desktop only; mobile is not supported).
- The ClingNote companion for Windows (free). It installs for your user only, needs **no administrator rights**, and runs quietly in the notification area.

## Install and connect
1. **Install the plugin:** *Settings, Community plugins, Browse*, search **ClingNote**, *Install*, then *Enable*.
2. **Install the companion:** download the setup from **https://clingnote.com/obsidian** and run it (its publisher shows as *Troy Burch*; the file is code-signed). Leave *Start the ClingNote companion* ticked.
3. **Connect:** the plugin connects by itself (Settings, ClingNote shows *Connected*, and the status bar stops saying *Disconnected*). If the sidebar says *Companion not installed*, use the *Download companion* link in the sidebar; if it says *installed but not running*, start **ClingNote for Obsidian** from the Start menu and press *Retry*.
4. **Use it:** open a file, app or web page, open an Obsidian note, then use the note's link icon (or the sidebar **+** button) to attach it. The first note you attach becomes **Main**.

## License and trial
Open **Settings, ClingNote, License & Pro**. There you can *Start 14-day trial*, paste your license key and *Activate*, *Deactivate* (frees one of your four activations), and *Refresh*. License keys are never stored in your vault; the companion keeps a signed license in Windows-protected storage. An active license keeps working offline until its signed period ends and renews itself when you are online.

## Privacy, network use and disclosures
- **No telemetry, no analytics, no ads, no account.**
- **The plugin** talks only to the companion on `127.0.0.1` (your own computer). It also opens a link in your browser when *you* click *Download companion* or *Get ClingNote Pro*, and opens attached files, folders or web pages when you ask it to.
- **The companion** (separate Windows program) reads the **title, path or address of the window you are using** to recognise contexts. This stays on your computer; it is not sent anywhere. Private browsing windows are not recorded.
- **Licensing network access:** only the companion contacts the ClingNote licensing service over HTTPS, and only when you start a trial, activate or deactivate a license, press *Refresh*, or (automatically) to renew a license close to expiry. It sends a one-way hash of your computer identifier (trial), a random per-installation ID, and your license key (activation only). It never sends note contents, file names, paths, URLs, window titles or context identifiers.
- **Files outside your vault:** the plugin reads the companion's connection file in `%LOCALAPPDATA%\ClingNote.Context` and file attributes of attached files (to open or reveal them safely). Your notes and vault stay where they are.
- **Closed-source component:** the companion is proprietary freeware and is not part of this repository. This plugin is open source (MIT, see `LICENSE`). **Payment** is optional: the plugin works for free as described above.

## Troubleshooting
- **Not connected / "Companion not installed":** install the companion, then *Retry*.
- **"Installed but not running":** start *ClingNote for Obsidian* from the Start menu.
- **"Connection interrupted":** the companion was closed or restarted; the plugin reconnects by itself, or press *Retry*.
- **"Not compatible":** install the latest companion.
- Excel, Word and Power BI contexts are recognised by window title, so two files with the same title can be confused. Windows Explorer, Notepad, other apps and browser pages are matched more precisely.

## Support
Questions or problems: support@clingnote.com, or open an issue in this repository.

## Building from source
`npm ci`, `npm test`, `npm run build` produce `main.js` (tests use Node's built-in runner; no network access is needed). Release assets are `main.js`, `manifest.json` and `styles.css`.

## License
Plugin source: MIT (see `LICENSE`). The ClingNote companion and ClingNote for Windows are separate proprietary products.
