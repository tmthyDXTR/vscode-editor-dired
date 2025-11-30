# Changelog

## Version 0.1.1 - 2025-11-30

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

## Files added / modified (high level)

- Modified:
  - `src/extension.ts` — added commands, status-bar undo UI, DocumentLinkProvider, terminal open command, delete/undo logic
  - `src/provider.ts` — `readFile` Uint8Array fix, `createFile`/`createDir`/`deleteSelected` refresh improvements, `notifyDirChanged`, `toggleDotFiles` refresh
  - `src/fileItem.ts` — used by link provider and parsing (no functional API change required)
  - `package.json` — added `extension.dired.openTerminal` activation and keybinding entries (and other keybindings already present were synced into README)
  - `README.md` — replaced with concise documentation and full keybindings list

## Notes & next steps

- Backups created for Undo live in the OS temporary folder and are not automatically cleaned up. Consider adding a cleanup strategy if needed.
- Some refresh/notification behavior depends on `dired.fixed_window` and `dired.show_path_in_tab` configuration; `notifyDirChanged` was added to make refresh behavior robust across modes.
- If Ctrl/Cmd+Click does not open links for you, check the `editor.multiCursorModifier` setting: if set to `ctrlCmd` then Ctrl+Click is used for multi-cursor; try Alt+Click or change the setting.