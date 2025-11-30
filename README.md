# vscode-dired

*vscode-dired* is an File Manager (or Directory Editor) for VS Code.

![vscode-dired Demo](https://github.com/shirou/vscode-dired/raw/master/vscode-dired.gif)

This is a port from Emacs dired-mode.

## Features

Filer used by only keyboard.

## Configuration

- `extension.dired.open`

## Key bindings (default)

Note: Keys are user-remappable in VS Code. These are the suggested defaults and the extension also sets a `dired.open` context so the bindings are active only in the Dired buffer.

- `ctrl+x d`  (chord)
  - Open Dired buffer / Open Directory.
- `Enter` (Return)
  - Open file or enter directory at cursor.
- `+`
  - Create new directory.
- `R` (Shift+R)
  - Rename selected file.
- `C` (Shift+C)
  - Copy selected file.
- `B` (Shift+B)
  - Go to parent (up) directory.
- `g`
  - Refresh current directory contents.
- `q`
  - Close Dired.
 - `ctrl+x ctrl+p`
   - Copy selected file or folder path to clipboard (copies the directory path if cursor is on the header).

Additional commands (not originally documented):

- `d` — Delete file (prompts for confirmation).
- `c` — Create file; completion dialog.
- `space` — Select files (marks for operations).
- `u` — Unselect files.
- `t` — Toggle showing dotfiles (hidden files).

Quick copy shortcut
- `ctrl+x ctrl+p` will copy the selected row's full filesystem path to the clipboard. If the cursor is positioned on the header (line 1), the current directory path is copied instead. The clipboard notification will indicate whether a file or a folder path was copied.

If you prefer different mappings, you can customize them in your keyboard shortcuts (File → Preferences → Keyboard Shortcuts or by editing `keybindings.json`).

Note: Dired editor tabs will display the directory path in the tab title (e.g., "C:\\Users\\Folder").
If `dired.fixed_window` is enabled the extension will ensure a single Dired editor instance is visible (closing other Dired tabs), but the tab title will still show the current directory path.

Configuration option `dired.show_path_in_tab`:
- `false` (default): When `dired.fixed_window` is enabled, Dired reuses a single editor (no new tabs). The header shows the full path but the tab title is fixed.
- `true`: When `dired.fixed_window` is enabled, Dired will still try to keep a single Dired tab but uses per-directory URIs so the tab title shows the current directory; this results in opening a new tab then closing others each time you change directories.
  - Note: When `dired.show_path_in_tab` is `true`, VS Code may briefly open a new tab for the directory before closing other Dired tabs — this can cause a short UI flicker. Set the option to `false` if you prefer a strictly single-tab, no-flicker workflow.

## Debugging and development

Recommended workflows for developing and debugging the extension (these are also available via the included `.vscode` configuration):

1) Watch + Launch (recommended)
 - Start TypeScript watch (compile on save):
```powershell
npm run watch
```
 - Start the debugger in VS Code: Run the "Launch Extension (watch)" configuration.
 - Make changes to `.ts` files and save — the watch task will recompile and the running extension will pick up the new code after reload/Restart Extension Host.

2) One-off compile + Launch
 - Compile the code once:
```powershell
npm run compile
```
 - Start the debugger using "Launch Extension (compile)".
 - Any further edits require a recompile and restart of the debug session.

3) Using built-in tasks
 - The `.vscode/tasks.json` includes tasks: `npm: watch`, `npm: compile`, and `npm: test`.
 - Use these tasks as `preLaunchTask` in the debug configuration if you want them to run automatically when you start debugging.

Source maps and breakpoints
 - `tsconfig.json` has `sourceMap: true` enabled by default so you can set breakpoints directly in `.ts` files.
 - The `launch.json` `outFiles` value points to `${workspaceFolder}/out/**/*.js` so the debugger can map to source files.

Reloading and quick iteration
 - If you keep the watch task running, you can use "Developer: Reload Window" or the debug "Restart Extension Host" command when you want to reload the running extension to pick up the latest changes.
 - For a complete reset, stop and re-run the debug session (F5).


## LICENSE

apache 2.0

---

Edited locally by supacoda