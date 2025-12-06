# Changelog

## Version 0.1.2 - 2025-12-01

- Added an "Open terminal in current Dired folder" command and keybinding
  - Command: `extension.dired.openTerminal`
  - Keybinding: `ctrl+x t`
  - Opens a terminal in the editor area (terminal editor) with the Dired folder as the terminal's working directory (no `cd` is executed inside the terminal).

- Created creation keybindings for files and folders
  - `ctrl+x ctrl+n f` — `extension.dired.createFile` (creates file on disk but does not open it)
  - `ctrl+x ctrl+n d` — `extension.dired.createDir` (creates directory)
  - Alternative keys kept: `ctrl+x =` and `shift+=`

- Implemented safer `readFile` return type
  - `src/provider.ts:readFile` now returns `Uint8Array` produced via `TextEncoder` to satisfy TypeScript expectations.

- Add/delete/create UX improvements
  - Deleting files/folders attempts to move items to the OS Trash (via `vscode.workspace.fs.delete(..., { useTrash: true })`) with fallback to `fs` removal.
  - A temporary recursive backup is stored in OS temp to support Undo for the last action.
  - Added persistent status-bar item showing the last action and providing an Undo command.
  - Undo command: `extension.dired.undoLastAction` — restores deleted items from backup or removes recently created items.

- Make Dired list refresh reliable
  - Added `DiredProvider.notifyDirChanged(dir: string)` to rebuild buffer and emit change notifications for the specific directory (and also the active Dired URI to support `fixed_window`).
  - `createFile`, `createDir`, `deleteSelected`, and `toggleDotFiles` now use `notifyDirChanged` / emit `_onDidChangeFile` so the view refreshes immediately.

- Replace popup notifications with status-bar messages
  - Most user feedback now uses `vscode.window.setStatusBarMessage(...)` instead of modal notifications.

- Added DocumentLinkProvider for Dired buffers
  - `src/extension.ts` registers a `DocumentLinkProvider` for language `dired` so filename text in the buffer becomes clickable (Ctrl/Cmd+Click or the configured link modifier) and opens the target file or navigates into the folder.
  - Uses `FileItem.parseLine(...)` to resolve filenames and target URIs.

- README updates
  - Reworked `README.md` into a concise doc describing features, commands, and a complete list of default keybindings (synchronized with `package.json`).

- Misc fixes and cleanups
  - Fixed variable redeclarations and other TypeScript issues during iterative edits.
  - Ensured `createFile` and `createDir` create items without opening them (create-file does not open the new file in editor).

- Low-level performance & memory hardening
  - Reused module-scoped `TextEncoder` / `TextDecoder` to avoid repeated allocations in hot paths.
  - Moved recursive helpers (`copyRecursive` / `restoreRecursive`) to module scope to avoid recreating closures.
  - Replaced blocking synchronous FS calls (`statSync`, `readdirSync`, `unlinkSync`, `rmSync`, etc.) with `fs.promises` in hot paths to prevent event-loop blocking and reduce peak memory.
  - Debounced `FileSystemWatcher` events and visible-range refreshes to coalesce rapid filesystem/scroll events.
  - Added a lightweight per-directory cache (minimal metadata) validated against directory `mtime`, with LRU eviction (default cap 10 directories), to reduce re-statting and allocations.
  - Limited `DocumentLinkProvider` work to `dired.maxEntries` lines to avoid generating huge numbers of links for very large directories.
  - Added `clearBuffers()` and ensured debounce timers and watcher resources are cleared on document close / provider dispose to free retained memory.
  - Other micro-optimizations: avoided intermediate Buffer allocations in `readFile`/`writeFile`, and moved hot helpers out of per-call closures.

  ## Version 0.1.3 - 2025-12-06

  - Fix: Ensure `toggleDotFiles` reliably refreshes the Dired view after toggling. `toggleDotFiles()` now clears the directory cache so the listing is rebuilt and dotfiles reappear when toggled back on.

  - Add: Toggle for unity `.meta` files.
    - New command: `extension.dired.toggleMetaFiles` (no default keybinding).
    - Provider flag `_show_meta_files` and `toggleMetaFiles()` implementation in `src/provider.ts`.

  - Add: Status-bar messages for many Dired commands (open, enter, toggle dotfiles, toggle .meta files, createDir, openTerminal, copy, delete, goUpDir, refresh, select/unselect, close) so users get immediate visual feedback.

  - Add: `provider.showDotFiles` and `provider.showMetaFiles` getters so the extension can report toggle state in the UI.

  - Add: `onLanguage:dired` activation event so the extension activates when Dired files open.

  - Improve: Contributed command names and titles to include a 'Dired:' prefix in the Command Palette for easier discovery.

  - Update: `package.json` now includes the commands that the extension registers and activation events for them so keybindings can reliably activate the extension and be discovered by the Command Palette.

  ## Files changed in this release

  - Modified: `src/provider.ts`, `src/extension.ts`, `package.json`, `README.md`, `out/*` compiled artifacts
