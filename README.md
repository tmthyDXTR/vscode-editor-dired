# vscode-dired

Fork of https://github.com/shirou/vscode-dired

Lightweight keyboard-first directory editor for VS Code (Emacs dired-inspired).

## Quick Summary
- Keyboard-driven file manager inside a read-only editor buffer.
- Create, delete, rename, and copy files and directories from the keyboard.
- Integrated terminal opens directly in the current Dired folder (terminal editor).


## Default Keybindings (full list)
Below are the default keybindings contributed by the extension (customizable in VS Code):

- `ctrl+x .` - Toggle dotfiles (show/hide hidden files)
- `ctrl+x d` - Open Dired / open directory
- `ctrl+x t` - Open integrated terminal in the current Dired folder (terminal editor; no extra `cd` is run)
- `ctrl+x ctrl+n f` - Create a new file in the current Dired directory (created but not opened)
- `ctrl+x ctrl+n d` - Create a new directory in the current Dired directory
- `ctrl+x ctrl+p` - Copy path of the selected row (or current directory when on header)
- `ctrl+x p` - Copy file / folder name
- `Enter` - Open file / enter directory
- `ctrl+x shift+d` - Delete selected file(s) or folder(s)
- `alt+w` - Copy selected file(s)/folder(s)
- `ctrl+b` - Go to parent (up) directory
- `ctrl+x r` - Refresh directory listing
- `ctrl+x f` - Find in folder (open the Find in Files view scoped to the current dired folder or selected file's parent folder; recursive include `**`)

Tip: All keybindings are customizable in VS Code keyboard shortcuts.

## Delete & Undo
- Deletes attempt to move items to the OS Trash/Recycle Bin when available and also keep a temporary backup to enable an "Undo" of the last action.
- A persistent status-bar item shows the last action and provides the Undo command (`Dired: Undo Last Action` / `extension.dired.undoLastAction`).
- Backups live in the OS temp folder and are not auto-purged by the extension.

## Commands
- `extension.dired.open` — Open a directory in Dired
- `extension.dired.openTerminal` — Open terminal in current Dired folder (terminal editor)
- `extension.dired.createFile` / `extension.dired.createDir` — Create file/dir in current Dired folder
- `extension.dired.undoLastAction` — Undo last create/delete action when available
- `extension.dired.findInFolder` — Open Find in Files view scoped to the current Dired folder or the parent of the selected file
- `extension.dired.copyPath` — Copy full path of the selected row (or current directory when on header)
- `extension.dired.copyName` — Copy filename of the selected row
- `extension.dired.toggleDotFiles` — Toggle dotfiles (show/hide hidden files)
- `extension.dired.toggleMetaFiles` — Toggle display of `.meta` files (Unity-style metadata)
- `extension.dired.rename` — Rename selected file or folder
- `extension.dired.copy` — Copy selected files/folders
- `extension.dired.delete` — Delete selected files/folders (tries Trash Bin)
- `extension.dired.goUpDir` — Go to the parent directory
- `extension.dired.refresh` — Refresh directory listing
- `extension.dired.select` / `extension.dired.unselect` — Select/unselect current file
- `extension.dired.close` — Close the active Dired buffer
- `extension.dired.debugLinkRanges` — Debug helper: writes computed link start columns into Dired Debug output channel

## Development
- Watch & debug (recommended):
 
```powershell
npm run watch
```

- One-off compile:
```powershell
npm run compile
```

- Package vsix:
```powershell
npm run package
```

Tasks: `.vscode/tasks.json` includes `npm: watch`, `npm: compile`, `npm: test`, `npm: package`.

## License
Apache-2.0

---