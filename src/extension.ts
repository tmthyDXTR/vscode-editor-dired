import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import FileItem from "./fileItem";
import DiredProvider from "./provider";
import { autocompletedInputBox } from "./autocompletedInputBox";
import debugUi from "./debugUi";

// Move recursive helpers to module scope to avoid recreating closures every time
async function copyRecursive(src: string, dest: string) {
    const sstat = await fs.promises.stat(src);
    if (sstat.isDirectory()) {
        await fs.promises.mkdir(dest, { recursive: true });
        for (const name of await fs.promises.readdir(src)) {
            await copyRecursive(path.join(src, name), path.join(dest, name));
        }
    } else {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
    }
}

async function restoreRecursive(src: string, dest: string) {
    const sstat = await fs.promises.stat(src);
    if (sstat.isDirectory()) {
        await fs.promises.mkdir(dest, { recursive: true });
        for (const name of await fs.promises.readdir(src)) {
            await restoreRecursive(path.join(src, name), path.join(dest, name));
        }
    } else {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
    }
}

export function activate(context: vscode.ExtensionContext) {
    "use strict";
    const cfg = vscode.workspace.getConfiguration("dired");
    const fixed_window = cfg.get<boolean>("fixed_window") || false;
    const ask_dir = cfg.get<boolean>("ask_directory") || false;

    const provider = new DiredProvider(fixed_window);

    // In-memory FileSystemProvider for an editable prompt document that lives under
    // the `dired-prompt:` scheme. This allows the document to be editable while
    // keeping its contents in-memory. We auto-save edits so closing the tab
    // doesn't trigger a "Save?" prompt.
    const promptScheme = 'dired-prompt';
    type InMemoryEntry = { content: Uint8Array, mtime: number };
    class InMemoryFs implements vscode.FileSystemProvider {
        private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
        private store: Map<string, InMemoryEntry> = new Map();
        watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
        stat(uri: vscode.Uri): vscode.FileStat {
            const key = uri.toString();
            const e = this.store.get(key);
            if (!e) throw vscode.FileSystemError.FileNotFound();
            return { type: vscode.FileType.File, ctime: e.mtime, mtime: e.mtime, size: e.content.length };
        }
        readDirectory(): [string, vscode.FileType][] { return []; }
        createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
        readFile(uri: vscode.Uri): Uint8Array {
            const key = uri.toString();
            console.log('memFs.readFile', key);
            const e = this.store.get(key);
            if (!e) throw vscode.FileSystemError.FileNotFound();
            return e.content;
        }
        async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean, overwrite: boolean }): Promise<void> {
            void _options;
            const key = uri.toString();
            console.log('memFs.writeFile', key, 'size', content.length);
            const now = Date.now();
            this.store.set(key, { content: content, mtime: now });
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        }
        // Public helper to remove an entry from the in-memory store.
        public deleteEntry(uri: vscode.Uri): void {
            try { this.store.delete(uri.toString()); } catch (e) { /* ignore */ }
        }
        delete(): void { throw vscode.FileSystemError.NoPermissions(); }
        rename(): void { throw vscode.FileSystemError.NoPermissions(); }
    }
    const memFs = new InMemoryFs();
    const memFsReg = vscode.workspace.registerFileSystemProvider(promptScheme, memFs, { isCaseSensitive: true });
    context.subscriptions.push(memFsReg);

    // Auto-save handler: when a dired-prompt document changes, call save() after
    // a short debounce so the document doesn't remain dirty and closing won't prompt.
    const saving = new Set<string>();
    const debounceTimers = new Map<string, NodeJS.Timeout>();
    // Track previous first-line content for prompt docs so we can detect
    // deletions that cross path separators and re-trigger suggestions.
    const prevFirstLine = new Map<string, string>();
    const onDidChangeDisposable = vscode.workspace.onDidChangeTextDocument((ev) => {
        try {
            const doc = ev.document;
            if (!doc || doc.uri.scheme !== promptScheme) return;
            const key = doc.uri.toString();
            // Check contentChanges for deletions that cross path separators
            try {
                const oldLine = prevFirstLine.get(key) || '';
                const newLine = doc.lineAt(0).text || '';
                // compute candidate portions after the prefix
                const oldCand = oldLine.replace(/^Dired open:\s*/, '');
                const newCand = newLine.replace(/^Dired open:\s*/, '');
                // Helper to get last separator index for either slash
                const lastSep = (s: string) => Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
                // If any change was a deletion
                let sawDeletion = false;
                for (const ch of ev.contentChanges) {
                    if (ch.rangeLength && ch.text === '') { sawDeletion = true; break; }
                }
                if (sawDeletion && oldCand.length > newCand.length) {
                    const oldIdx = lastSep(oldCand);
                    const newIdx = lastSep(newCand);
                    // Trigger if deletion crossed a separator (moved to parent dir)
                    // or the new candidate ends with a separator (user deleted to the slash)
                    if (oldIdx !== newIdx || newCand.endsWith('\\') || newCand.endsWith('/')) {
                        // Only trigger when this document is active in the editor
                        const active = vscode.window.activeTextEditor;
                        if (active && active.document && active.document.uri.toString() === key) {
                            // Trigger suggestions asynchronously to avoid re-entrancy
                            setTimeout(() => { try { vscode.commands.executeCommand('editor.action.triggerSuggest'); } catch (e) { /* ignore */ } }, 0);
                        }
                    }
                }
            } catch (e) { /* ignore detection errors */ }
            const prev = debounceTimers.get(key);
            if (prev) clearTimeout(prev);
            const t = setTimeout(async () => {
                debounceTimers.delete(key);
                if (saving.has(key)) return;
                saving.add(key);
                try {
                    // Ensure provider is updated by saving the document which will call writeFile
                    await doc.save();
                } catch (e) { /* ignore save errors */ }
                saving.delete(key);
            }, 200);
            debounceTimers.set(key, t);
            // update prevFirstLine for next change
            try { prevFirstLine.set(key, doc.lineAt(0).text || ''); } catch (e) { }
        } catch (e) { /* ignore */ }
    });
    const commandOpenTerminal = vscode.commands.registerCommand("extension.dired.openTerminal", async () => {
        try {
            const selectedCandidate = provider.getSelectedPath();
            const fallback = provider.dirname || os.homedir();
            const selected: string = selectedCandidate ? selectedCandidate : fallback;
            let cwd: string = selected;
            try {
                const stat = await fs.promises.stat(selected);
                if (stat.isFile()) cwd = path.dirname(selected);
            } catch (e) { cwd = fallback; }
            try {
                const term = vscode.window.createTerminal({ cwd, name: `dired: ${path.basename(cwd)}` });
                term.show(false);
                vscode.window.setStatusBarMessage(`Opened terminal in ${cwd}`, 3000);
            } catch (e) {
                const fallbackTerm = vscode.window.createTerminal({ cwd, name: `dired: ${path.basename(cwd)}` });
                fallbackTerm.show(false);
                vscode.window.setStatusBarMessage(`Opened terminal in ${cwd}`, 3000);
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to open terminal: ${err}`, 5000);
        }
    });
    context.subscriptions.push(onDidChangeDisposable);
    const onDidCloseDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        try {
            if (doc && doc.uri && doc.uri.scheme === promptScheme) {
                // cleanup stored content
                try { memFs.deleteEntry(doc.uri); } catch (e) { }
                try { prevFirstLine.delete(doc.uri.toString()); } catch (e) { }
                vscode.commands.executeCommand('setContext', 'dired.promptOpen', false);
            }
        } catch (e) { /* ignore */ }
    });
    context.subscriptions.push(onDidCloseDisposable);

    // Decoration type used to highlight the filename portion of marked items
    const markedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.selectionBackground'),
        borderRadius: '2px'
    });
    context.subscriptions.push(markedDecoration);

    // Decoration used to render the '*' marker at the start of the line
    const markerDecoration = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '*',
            margin: '0 6px 0 0',
            color: new vscode.ThemeColor('editor.foreground')
        }
    });
    context.subscriptions.push(markerDecoration);

    // Persistent status bar item for last action with undo
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'extension.dired.undoLastAction';
    context.subscriptions.push(statusItem);

    // Last action state (persist across reloads in workspaceState)
    type LastAction = { type: 'delete'|'create', path: string, backup?: string, isDirectory?: boolean } | null;
    let lastAction: LastAction = context.workspaceState.get<LastAction>('dired.lastAction') || null;
    function setLastAction(action: LastAction) {
        lastAction = action;
        context.workspaceState.update('dired.lastAction', action);
        if (action) {
            if (action.type === 'delete') {
                statusItem.text = `$(trash) Deleted ${path.basename(action.path)} — Undo`;
                statusItem.tooltip = `Restore ${action.path}`;
                statusItem.show();
            } else if (action.type === 'create') {
                statusItem.text = `$(plus) Created ${path.basename(action.path)} — Undo`;
                statusItem.tooltip = `Remove ${action.path}`;
                statusItem.show();
            }
        } else {
            statusItem.hide();
        }
    }
    // Initialize status bar from persisted state
    setLastAction(lastAction);

    // Register the Dired provider as a FileSystemProvider so dired:// documents are editable.
    // This lets users edit filenames inline and save (writeFile) will be invoked.
    // Guard registration so activation does not fail if another extension already
    // registered the same scheme (e.g., after renaming the extension or when
    // another copy is installed in the host).
    let providerRegistrations: vscode.Disposable;
    try {
        const reg = vscode.workspace.registerFileSystemProvider(DiredProvider.scheme, provider as unknown as vscode.FileSystemProvider, { isCaseSensitive: true });
        providerRegistrations = vscode.Disposable.from(reg);
    } catch (err) {
        // If a provider for this scheme is already registered, don't crash.
        console.warn('Dired: failed to register FileSystemProvider for scheme', DiredProvider.scheme, err);
        try { vscode.window.showWarningMessage('Dired: another extension already provides the "dired" scheme. Some features may be limited. Consider removing the duplicate extension.'); } catch (e) { }
        // Provide a noop disposable so later context.subscriptions.push works uniformly.
        providerRegistrations = new vscode.Disposable(() => { /* noop */ });
    }
    const commandOpen = vscode.commands.registerCommand("extension.dired.open", () => {
        let dir = vscode.workspace.rootPath;
        const at = vscode.window.activeTextEditor;
        if (at) {
            if (at.document.uri.scheme === DiredProvider.scheme) {
                dir = provider.dirname;
            } else {
                const doc = at.document;
                dir = path.dirname(doc.fileName);
            }
        }
        if (!dir) {
            dir = require('os').homedir();
        }
        if (dir) {
            if (!ask_dir) {
                provider.openDir(dir);
                vscode.window.setStatusBarMessage(`Dired: Opened ${dir}`, 3000);
            } else {
                (async () => {
                    // Open an untitled editor so the user can edit the path inline (like the terminal input).
                    // The completion provider registered above will offer file/folder completions while the
                    // first line begins with "Dired open:".
                    try {
                        const initial = `Dired open: ${dir}${path.sep}`;
                        // Build a readonly virtual document URI and open it so closing the tab
                        // won't prompt to save (virtual docs are not dirty).
                        const uri = vscode.Uri.from({ scheme: promptScheme, path: `/${encodeURIComponent(dir)}` });
                        // Ensure initial content exists in the in-memory FS so the document can open.
                        try {
                            const initialBytes = new TextEncoder().encode(initial);
                            console.log('writing initial prompt to memFs', uri.toString());
                            await memFs.writeFile(uri, initialBytes, { create: true, overwrite: true });
                        } catch (e) { console.error('failed to write initial prompt', e); }
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(doc, { preview: false });
                        // set context so keybinding can trigger accept command
                        await vscode.commands.executeCommand('setContext', 'dired.promptOpen', true);
                        // Seed previous-first-line content so deletions are detected
                        try { prevFirstLine.set(uri.toString(), initial); } catch (e) { }
                        // Place the cursor at the end of the path on the first line so typing continues there
                        try {
                            const firstLine = doc.lineAt(0).text;
                            const pos = new vscode.Position(0, firstLine.length);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos));
                        } catch (e) { /* ignore selection errors */ }
                        // Leave the prompt open; user should press Enter (bound to accept command) to open.
                        return;
                    } catch (e) {
                        try { vscode.window.showErrorMessage('Dired: failed to open prompt: ' + String(e)); } catch (ee) { /* ignore UI errors */ }
                        console.error('Dired: failed to open prompt', e);
                    }
                })();
            }
        }
    });
    const commandEnter = vscode.commands.registerCommand("extension.dired.enter", () => {
        const selected = provider.getSelectedPath();
        provider.enter();
        if (selected) vscode.window.setStatusBarMessage(`Opened ${selected}`, 3000);
    });
    const commandToggleDotFiles = vscode.commands.registerCommand("extension.dired.toggleDotFiles", () => {
        console.log('Dired: toggleDotFiles command invoked');
        provider.toggleDotFiles();
        try { vscode.window.setStatusBarMessage(`Dired: ${provider.showDotFiles ? 'Showing' : 'Hiding'} dotfiles`, 3000); } catch (e) { }
    });
    const commandToggleMetaFilesCmd = vscode.commands.registerCommand("extension.dired.toggleMetaFiles", () => {
        console.log('Dired: toggleMetaFiles command invoked');
        provider.toggleMetaFiles();
        try { vscode.window.setStatusBarMessage(`Dired: ${provider.showMetaFiles ? 'Showing' : 'Hiding'} .meta files`, 3000); } catch (e) { }
    });
    

    const commandCreateDir = vscode.commands.registerCommand("extension.dired.createDir", async () => {
        const dirName = await vscode.window.showInputBox({ prompt: "Directory name" });
        if (!dirName) {
            return;
        }
        // create and set lastAction so undo is possible
        const cwd = provider.dirname;
        if (!cwd) {
            vscode.window.setStatusBarMessage('Cannot determine current directory to create directory in.', 5000);
            return;
        }
        const p = path.join(cwd, dirName);
        try {
            await provider.createDir(dirName);
            // record create action
            await context.workspaceState.update('dired.lastAction', { type: 'create', path: p });
            setTimeout(() => { /* refresh already done by provider.createDir */ }, 0);
            vscode.window.setStatusBarMessage(`Created ${p} (undo available)`, 3000);
            try { statusItem.text = `$(plus) Created ${path.basename(p)} — Undo`; statusItem.tooltip = `Remove ${p}`; statusItem.show(); } catch {}
            vscode.window.setStatusBarMessage(`Created ${p}`, 3000);
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to create directory ${p}: ${err}`, 5000);
        }
    });
    const commandRename = vscode.commands.registerCommand("extension.dired.rename", () => {
        vscode.window.showInputBox()
            .then((newName: string) => {
                provider.renameSelected(newName);
            });
    });
    const commandCopy = vscode.commands.registerCommand("extension.dired.copy", () => {
        const marked = provider.getMarkedPaths() || [];
        // If multiple marked files exist, prompt for target directory and copy all
        if (marked.length > 1) {
            const cwd = provider.dirname || require('os').homedir();
            const defaultDest = path.join(cwd, 'marked-copy');
            vscode.window.showInputBox({ prompt: 'Copy marked files to directory', value: defaultDest })
                .then(async (dest: string | undefined) => {
                    if (!dest) return;
                    try {
                        await fs.promises.mkdir(dest, { recursive: true });
                        for (const src of marked) {
                            const destPath = path.join(dest, path.basename(src));
                            try {
                                await copyRecursive(src, destPath);
                            } catch (e) {
                                // try fallback copy per-file
                                try { await fs.promises.copyFile(src, destPath); } catch (ee) { }
                            }
                        }
                        vscode.window.setStatusBarMessage(`Copied ${marked.length} files to ${dest}`, 3000);
                        try { await provider.notifyDirChanged(dest); } catch (e) { }
                    } catch (err) {
                        vscode.window.setStatusBarMessage(`Failed to copy marked files: ${err}`, 5000);
                    }
                });
            return;
        }

        // Single file fallback: behave like before
        const selected = provider.getSelectedPath();
        if (!selected) {
            vscode.window.setStatusBarMessage('No file or folder selected to copy', 3000);
            return;
        }
        // Suggest a sensible default destination: same directory with "-copy" suffix
        const cwd = provider.dirname || path.dirname(selected);
        const basename = path.basename(selected);
        const defaultDest = path.join(cwd, basename + '-copy');
        vscode.window.showInputBox({ prompt: 'Copy to (absolute or relative path)', value: defaultDest })
            .then((newName: string | undefined) => {
                if (!newName) return;
                provider.copySelected(newName);
                vscode.window.setStatusBarMessage(`Copying to ${newName}`, 3000);
            });
    });

    const commandDelete = vscode.commands.registerCommand("extension.dired.delete", async () => {
        const item = await vscode.window.showQuickPick(["Yes", "No"], { placeHolder: "Delete this file?" });
        if (item !== "Yes") return;
        // Determine marked selections first
        const marked = provider.getMarkedPaths() || [];
        const cwd = provider.dirname;
        if ((!marked || marked.length === 0)) {
            // Single-delete fallback
            const selected = provider.getSelectedPath();
            if (!selected || !cwd) {
                vscode.window.setStatusBarMessage('No file selected to delete', 3000);
                return;
            }
            // Prevent deleting the header directory itself
            if (path.resolve(cwd) === path.resolve(selected)) {
                vscode.window.setStatusBarMessage('Cannot delete the directory header', 3000);
                return;
            }
            try {
                const stat = await fs.promises.stat(selected);
                const isDir = stat.isDirectory();
                // Create a backup copy to allow undo
                const backupRoot = path.join(os.tmpdir(), 'vscode-dired-backup');
                await fs.promises.mkdir(backupRoot, { recursive: true });
                const backupName = `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${path.basename(selected)}`;
                const backupPath = path.join(backupRoot, backupName);
                // Copy recursively to backup using module-level helper
                await copyRecursive(selected, backupPath);

                // Move original to OS Trash
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.file(selected), { useTrash: true });
                } catch (e) {
                    // Fallback to fs rm if workspace API fails
                    if (isDir) {
                        try { await fs.promises.rm(selected, { recursive: true, force: true }); } catch { try { await fs.promises.rmdir(selected); } catch {} }
                    } else {
                        try { await fs.promises.unlink(selected); } catch {}
                    }
                }

                // Remember last action for undo
                setLastAction({ type: 'delete', path: selected, backup: backupPath, isDirectory: isDir });
                // Notify provider to refresh that directory listing directly (avoids relying on this.dirname)
                try { await provider.notifyDirChanged(path.dirname(selected)); } catch {}
                vscode.window.setStatusBarMessage(`${selected} moved to Trash (undo available)`, 5000);
            } catch (err) {
                vscode.window.setStatusBarMessage(`Failed to delete ${selected}: ${err}`, 5000);
            }
            return;
        }

        // Multi-delete: copy all marked items into a single backup directory, then remove
        try {
            if (!cwd) {
                vscode.window.setStatusBarMessage('No active directory for multi-delete', 3000);
                return;
            }
            const markedFiltered = marked.filter(p => path.resolve(p) !== path.resolve(cwd));
            if (markedFiltered.length === 0) {
                vscode.window.setStatusBarMessage('No valid marked files to delete', 3000);
                return;
            }
            const backupRoot = path.join(os.tmpdir(), 'vscode-dired-backup');
            await fs.promises.mkdir(backupRoot, { recursive: true });
            const backupName = `${Date.now()}-${Math.random().toString(36).slice(2,8)}-multi`;
            const backupPath = path.join(backupRoot, backupName);
            await fs.promises.mkdir(backupPath, { recursive: true });
            for (const src of markedFiltered) {
                const dest = path.join(backupPath, path.basename(src));
                try {
                    await copyRecursive(src, dest);
                } catch (e) {
                    // try per-file copy fallback
                    try { await fs.promises.copyFile(src, dest); } catch (ee) { }
                }
            }
            // Now delete originals (move to trash)
            for (const src of markedFiltered) {
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.file(src), { useTrash: true });
                } catch (e) {
                    try {
                        const stat = await fs.promises.stat(src);
                        if (stat.isDirectory()) {
                            try { await fs.promises.rm(src, { recursive: true, force: true }); } catch { try { await fs.promises.rmdir(src); } catch {} }
                        } else {
                            try { await fs.promises.unlink(src); } catch {}
                        }
                    } catch (ee) { /* ignore */ }
                }
            }

            // Record last action for undo: set path to the directory so restoreRecursive
            // will copy backup contents back into the folder.
            setLastAction({ type: 'delete', path: cwd, backup: backupPath, isDirectory: true });
            try { await provider.notifyDirChanged(cwd); } catch (e) { }
            vscode.window.setStatusBarMessage(`Deleted ${markedFiltered.length} items (undo available)`, 5000);
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to delete marked files: ${err}`, 5000);
        }
    });

    const commandGoUpDir = vscode.commands.registerCommand("extension.dired.goUpDir", () => {
        provider.goUpDir();
        try { const d = provider.dirname ? path.resolve(provider.dirname, '..') : undefined; if (d) vscode.window.setStatusBarMessage(`Moved to ${d}`, 3000); } catch (e) {}
    });

    const commandRefresh = vscode.commands.registerCommand("extension.dired.refresh", () => {
        provider.reload();
        try { vscode.window.setStatusBarMessage(`Dired: refreshed`, 1500); } catch (e) {}
    });
    const commandSelect = vscode.commands.registerCommand("extension.dired.select", () => {
        provider.select();
        vscode.window.setStatusBarMessage(`Dired: selection updated`, 1500);
    });
    const commandToggleSelect = vscode.commands.registerCommand("extension.dired.toggleSelect", () => {
        try {
            provider.toggleSelectCurrent();
        } catch (e) { /* ignore */ }
    });
    const commandShowMarked = vscode.commands.registerCommand('extension.dired.showMarked', () => {
        try { debugUi.showMarkedInActiveBuffer(provider.getMarkedPaths()); } catch (e) { /* ignore */ }
    });

    // Helper to update decorations in the active Dired editor to highlight
    // the filename portion of marked items.
    function updateMarkedDecorations(editor?: vscode.TextEditor | undefined) {
        try {
            const ed = editor || vscode.window.activeTextEditor;
            if (!ed || !ed.document || ed.document.uri.scheme !== DiredProvider.scheme) {
                // clear decorations in any visible dired editors
                for (const e of vscode.window.visibleTextEditors) {
                    try { if (e.document && e.document.uri.scheme === DiredProvider.scheme) e.setDecorations(markedDecoration, []); } catch (er) { }
                }
                return;
            }

            // Derive directory from header like provider does
            let header = ed.document.lineAt(0).text || '';
            header = header.replace(/:\s*$/, '');
            header = header.replace(/^Dired:\s*/, '').trim();
            const dir = header || '.';

            const marked = new Set(provider.getMarkedPaths().map(p => path.resolve(p)));
            const opts: vscode.DecorationOptions[] = [];
            const markerOpts: vscode.DecorationOptions[] = [];
            for (let i = 1; i < ed.document.lineCount; i++) {
                try {
                    const line = ed.document.lineAt(i).text;
                    if (!line || !line.trim()) continue;
                    const item = FileItem.parseLine(dir, line);
                    if (!item || !item.fileName) continue;
                    const abs = path.resolve(dir, item.fileName);
                    if (!marked.has(abs)) continue;
                    const startCol = (typeof item.startColumn === 'number') ? item.startColumn : Math.max(0, line.lastIndexOf(item.fileName));
                    const range = new vscode.Range(new vscode.Position(i, startCol), new vscode.Position(i, startCol + item.fileName.length));
                    opts.push({ range, hoverMessage: 'Marked' });
                    // marker at line start
                    try { markerOpts.push({ range: new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, 0)) }); } catch (e) { }
                } catch (e) { /* ignore parse errors */ }
            }
            ed.setDecorations(markedDecoration, opts);
            ed.setDecorations(markerDecoration, markerOpts);
        } catch (e) { /* ignore errors while decorating */ }
    }

    // Update decorations when provider notifies or active editor changes or doc changes
    try { provider.onDidChange(() => updateMarkedDecorations()); } catch (e) { }
    try { provider.onDidSelectChange(() => updateMarkedDecorations()); } catch (e) { }
    try { vscode.window.onDidChangeActiveTextEditor((ed) => updateMarkedDecorations(ed)); } catch (e) { }
    try { vscode.workspace.onDidChangeTextDocument((ev) => { if (ev.document && ev.document.uri.scheme === DiredProvider.scheme) updateMarkedDecorations(); }); } catch (e) { }
    const commandUnselect = vscode.commands.registerCommand("extension.dired.unselect", () => {
        provider.unselect();
        vscode.window.setStatusBarMessage(`Dired: selection updated`, 1500);
    });
    const commandClose = vscode.commands.registerCommand("extension.dired.close", () => {
        vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        vscode.window.setStatusBarMessage(`Closed Dired`, 1500);
    });

    const commandCreateFile = vscode.commands.registerCommand("extension.dired.createFile", async () => {
        async function completionFunc(filePathOrDirPath: string): Promise<Iterable<vscode.QuickPickItem>> {
            const items: vscode.QuickPickItem[] = [];
            let dirname: string | undefined;
            if (!path.isAbsolute(filePathOrDirPath)) {
                if (provider.dirname == undefined) return items;
                filePathOrDirPath = path.join(provider.dirname, filePathOrDirPath);
            }
            try {
                try {
                    const stat = await fs.promises.stat(filePathOrDirPath);
                    if (stat.isDirectory()) {
                        dirname = filePathOrDirPath;
                        items.push({ detail: "Open " + path.basename(filePathOrDirPath) + "/", label: filePathOrDirPath, buttons: [ { iconPath: vscode.ThemeIcon.Folder } ] });
                    } else {
                        items.push({ detail: "Open " + path.basename(filePathOrDirPath), label: filePathOrDirPath, buttons: [ { iconPath: vscode.ThemeIcon.File } ] });
                        dirname = path.dirname(filePathOrDirPath);
                    }
                } catch {
                    items.push({ detail: "Create " + path.basename(filePathOrDirPath), label: filePathOrDirPath, buttons: [ { iconPath: vscode.ThemeIcon.File } ] });
                    dirname = path.dirname(filePathOrDirPath);
                    try { await fs.promises.access(filePathOrDirPath, fs.constants.F_OK); } catch { return items; }
                }

                if (dirname) {
                    try {
                        const names = await fs.promises.readdir(dirname);
                        for (const name of names) {
                            const fullpath = path.join(dirname, name);
                            try {
                                const s = await fs.promises.stat(fullpath);
                                if (s.isDirectory()) {
                                    items.push({ label: fullpath, detail: "Open " + name + "/", buttons: [ { iconPath: vscode.ThemeIcon.Folder } ] });
                                } else {
                                    items.push({ label: fullpath, detail: "Open" + name, buttons: [ { iconPath: vscode.ThemeIcon.File } ] });
                                }
                            } catch (e) { /* ignore individual stat errors */ }
                        }
                    } catch (e) { /* ignore read errors */ }
                }
            } catch (e) {
                // ignore
            }
            return items;
        }
        function processSelf(self: vscode.QuickPick<vscode.QuickPickItem>) {
            self.placeholder = "Create File or Open"
        }
        const fileName = await autocompletedInputBox(
            {
                completion: completionFunc,
                withSelf: processSelf,
            });
        // Show chosen filename in the status bar rather than popup
        if (fileName) vscode.window.setStatusBarMessage(`${fileName}`, 3000);
        let isDirectory = false;

        try {
            const stat = await fs.promises.stat(fileName);
            if (stat.isDirectory())
                isDirectory = true;
        }
        catch {
            await fs.promises.mkdir(path.dirname(fileName), { recursive: true })
            await fs.promises.writeFile(fileName, "");
        }

        if (isDirectory) {
            provider.openDir(fileName)
        }
        else {
            await provider.createFile(fileName)
            // record create action for undo
            const cwd = provider.dirname;
            const createdPath = path.isAbsolute(fileName) ? fileName : path.join(cwd || '', fileName);
            await context.workspaceState.update('dired.lastAction', { type: 'create', path: createdPath });
            try { statusItem.text = `$(plus) Created ${path.basename(createdPath)} — Undo`; statusItem.tooltip = `Remove ${createdPath}`; statusItem.show(); } catch {}
        }

    });

    const commandCopyPath = vscode.commands.registerCommand("extension.dired.copyPath", async () => {
        const p = provider.getSelectedPath();
        if (!p) {
            vscode.window.setStatusBarMessage("No file or folder selected to copy path.", 3000);
            return;
        }
        try {
            const normalized = path.resolve(p);
            await vscode.env.clipboard.writeText(normalized);
            try {
                const stat = await fs.promises.stat(normalized);
                if (stat.isDirectory()) {
                    vscode.window.setStatusBarMessage(`Copied folder path: ${normalized}`, 3000);
                } else {
                    vscode.window.setStatusBarMessage(`Copied file path: ${normalized}`, 3000);
                }
            } catch (e) {
                vscode.window.setStatusBarMessage(`Copied path: ${normalized}`, 3000);
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to copy path: ${err}`, 5000);
        }
    });

    const commandCopyName = vscode.commands.registerCommand("extension.dired.copyName", async () => {
        const p = provider.getSelectedPath();
        if (!p) {
            vscode.window.setStatusBarMessage("No file or folder selected to copy name.", 3000);
            return;
        }
        try {
            const name = path.basename(p);
            await vscode.env.clipboard.writeText(name);
            try {
                const stat = await fs.promises.stat(p);
                if (stat.isDirectory()) {
                    vscode.window.setStatusBarMessage(`Copied folder name: ${name}`, 3000);
                } else {
                    vscode.window.setStatusBarMessage(`Copied file name: ${name}`, 3000);
                }
            } catch (e) {
                vscode.window.setStatusBarMessage(`Copied name: ${name}`, 3000);
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to copy name: ${err}`, 5000);
        }
    });

    context.subscriptions.push(
        provider,
        commandOpen,
        commandEnter,
        commandToggleDotFiles,
        commandToggleMetaFilesCmd,
        commandCreateDir,
        commandOpenTerminal,
        commandCreateFile,
        commandRename,
        commandCopy,
        commandToggleSelect,
        commandShowMarked,
        commandGoUpDir,
        commandCopyName,
        commandRefresh,
        commandClose,
        commandDelete,
        commandSelect,
        commandUnselect,
        providerRegistrations
    );
    context.subscriptions.push(commandCopyPath);

    // Find in folder: open search view scoped to selected folder or current provider dirname
    const commandFindInFolder = vscode.commands.registerCommand("extension.dired.findInFolder", async () => {
        try {
            const selected = provider.getSelectedPath();
            let dir = provider.dirname || undefined;
            if (selected) {
                try {
                    const st = await fs.promises.stat(selected);
                    if (st.isDirectory()) {
                        dir = selected;
                    } else {
                        dir = path.dirname(selected);
                    }
                } catch (e) {
                    // fallback to provider dirname
                    dir = provider.dirname || dir;
                }
            }
            if (!dir) {
                vscode.window.setStatusBarMessage('Dired: No folder selected to search in', 3000);
                return;
            }
            // Use recursive glob pattern and normalize slashes to forward for cross-platform support
            const includePattern = (path.join(dir, '**')).replace(/\\/g, '/');
            await vscode.commands.executeCommand('workbench.action.findInFiles', {
                query: '',
                filesToInclude: includePattern,
                triggerSearch: false
            });
            vscode.window.setStatusBarMessage(`Dired: Searching in ${dir}`, 1500);
        } catch (err) {
            vscode.window.setStatusBarMessage(`Dired search failed: ${err}`, 5000);
        }
    });
    context.subscriptions.push(commandFindInFolder);

    // Make filenames clickable in the Dired buffer (Ctrl/Cmd+Click)
    // Register a DocumentLinkProvider for the `dired` language that creates
    // links for the filename column (column 52+) and targets either a file URI
    // or a `dired:` directory URI so clicking opens the file or navigates the folder.
    const linkProvider = vscode.languages.registerDocumentLinkProvider({ language: 'dired' }, {
        provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
            const links: vscode.DocumentLink[] = [];
            // Determine directory from header line (same logic as provider.dirname)
            let header = document.lineAt(0).text || '';
            header = header.replace(/:\s*$/, '');
            header = header.replace(/^Dired:\s*/, '').trim();
            const dir = header || undefined;

            // Create links for the document up to a safe cap (`dired.maxEntries`) so
            // links are immediately available. This avoids the complexity of trying
            // to force VS Code to re-run link providers on scroll.
            const cfg = vscode.workspace.getConfiguration('dired');
            const MAX_LINK_LINES = cfg.get<number>('maxEntries') || 5000;
            const endLine = Math.min(document.lineCount - 1, MAX_LINK_LINES);
            for (let i = 1; i <= endLine; i++) {
                const line = document.lineAt(i).text;
                if (!line || !line.trim()) continue;
                try {
                    const item = FileItem.parseLine(dir || '.', line);
                    const fname = item.fileName;
                    if (!fname) continue;
                    // Determine filename start position by finding its last occurrence.
                    let startCol = Math.max(0, (typeof item.startColumn === 'number') ? item.startColumn : line.lastIndexOf(fname));
                    try {
                        const timeMatch = line.match(/\d{2}:\d{2}/);
                        if (timeMatch && typeof timeMatch.index === 'number') {
                            // Find first non-space token after HH:MM; assume that's the filename start
                            let pos = timeMatch.index + timeMatch[0].length;
                            while (pos < line.length && line.charAt(pos) === ' ') pos++;
                            if (pos < line.length) startCol = pos;
                        }
                    } catch (e) { /* ignore */ }
                    if (startCol < 0) continue;
                    const startPos = new vscode.Position(i, startCol);
                    const endPos = new vscode.Position(i, startCol + fname.length);
                    const range = new vscode.Range(startPos, endPos);
                    const target = item.uri;
                    if (target) {
                        links.push(new vscode.DocumentLink(range, target));
                    }
                } catch (e) {
                    // ignore parse errors for malformed lines
                }
            }
            return links;
        }
    });
    context.subscriptions.push(linkProvider);

    // Completion provider for the temporary "Dired open" editor.
    // It only returns items when the document's first line begins with "Dired open:"
    const editorPromptCompletion = vscode.languages.registerCompletionItemProvider({ scheme: 'dired-prompt' }, {
        async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            try {
                const first = document.lineAt(0).text || '';
                if (!first.startsWith('Dired open:')) return undefined;
                // compute the current input after the prefix on the first line
                const prefix = first.replace(/^Dired open:\s*/, '');
                const line = document.lineAt(position.line).text;
                // only provide completions when on the first line
                if (position.line !== 0) return undefined;
                // cursor index relative to full line
                const relIdx = position.character;
                const beforeCursor = line.substring('Dired open: '.length, relIdx);
                let candidate = beforeCursor && beforeCursor.length ? beforeCursor : prefix;
                if (!candidate) candidate = require('os').homedir();
                if (!path.isAbsolute(candidate)) candidate = path.join(vscode.workspace.rootPath || require('os').homedir(), candidate);
                const items: vscode.CompletionItem[] = [];
                try {
                    const stat = await fs.promises.stat(candidate);
                    if (stat.isDirectory()) {
                        const names = await fs.promises.readdir(candidate);
                        // parent
                        const parent = path.join(candidate, '..');
                        const startCol = 'Dired open: '.length;
                        const lineLen = document.lineAt(0).text.length;
                        const replaceRange = new vscode.Range(new vscode.Position(0, startCol), new vscode.Position(0, lineLen));
                        const pitem = new vscode.CompletionItem(parent, vscode.CompletionItemKind.Folder) as vscode.CompletionItem & { range?: vscode.Range };
                        pitem.detail = '.. (parent)';
                        // Append a trailing slash for directories so users can see/select it
                        pitem.insertText = parent + '\\';
                        // Reopen suggestions after inserting a directory so user can continue completing
                        pitem.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
                        pitem.range = replaceRange;
                        items.push(pitem);
                        for (const name of names) {
                            const full = path.join(candidate, name);
                            try {
                                const s = await fs.promises.stat(full);
                                const it = new vscode.CompletionItem(full, s.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File) as vscode.CompletionItem & { range?: vscode.Range };
                                it.detail = name + (s.isDirectory() ? '\\' : '');
                                // For directories append a trailing slash in the inserted text
                                it.insertText = s.isDirectory() ? (full + '\\') : full;
                                if (s.isDirectory()) {
                                    it.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
                                }
                                it.range = replaceRange;
                                items.push(it);
                            } catch (e) { }
                        }
                        return items;
                    }
                } catch (e) {
                    const parent = path.dirname(candidate || '');
                    try {
                        const names = await fs.promises.readdir(parent);
                        const startCol = 'Dired open: '.length;
                        const lineLen = document.lineAt(0).text.length;
                        const replaceRange = new vscode.Range(new vscode.Position(0, startCol), new vscode.Position(0, lineLen));
                        for (const name of names) {
                            const full = path.join(parent, name);
                            try {
                                const s = await fs.promises.stat(full);
                                const it = new vscode.CompletionItem(full, s.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File) as vscode.CompletionItem & { range?: vscode.Range };
                                it.detail = name + (s.isDirectory() ? '\\' : '');
                                it.insertText = s.isDirectory() ? (full + '\\') : full;
                                if (s.isDirectory()) {
                                    it.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
                                }
                                it.range = replaceRange;
                                items.push(it);
                            } catch (e) { }
                        }
                        return items;
                    } catch (e) { return undefined; }
                }
                return undefined;
            } catch (e) { return undefined; }
        }
    }, '/', '\\', '.');
    context.subscriptions.push(editorPromptCompletion);

    // Command to accept the Dired prompt from the readonly virtual document
    const commandAcceptPrompt = vscode.commands.registerCommand('extension.dired.acceptPrompt', async () => {
        try {
            const ed = vscode.window.activeTextEditor;
            if (!ed || !ed.document || ed.document.uri.scheme !== 'dired-prompt') return;
            const first = ed.document.lineAt(0).text.replace(/^Dired open:\s*/, '').trim();
            if (!first) return;
            const baseDir = decodeURIComponent(ed.document.uri.path || '').replace(/^\//, '') || vscode.workspace.rootPath || os.homedir();
            const resolved = path.isAbsolute(first) ? first : path.join(baseDir, first);
            try {
                const st = await fs.promises.stat(resolved);
                if (st.isDirectory()) {
                    await provider.openDir(resolved);
                } else if (st.isFile()) {
                    const f = new FileItem(resolved, "", false, true);
                    const uri = f.uri;
                    if (uri) provider.showFile(uri);
                }
            } catch (e) {
                // ignore
            }
            // Close the prompt editor
            try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch (e) { }
            await vscode.commands.executeCommand('setContext', 'dired.promptOpen', false);
        } catch (e) { /* ignore */ }
    });
    context.subscriptions.push(commandAcceptPrompt);

    // Debug command to inspect computed link start columns in the current Dired buffer
    const commandDebugLinks = vscode.commands.registerCommand('extension.dired.debugLinkRanges', async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document.uri.scheme !== 'dired') {
            vscode.window.showInformationMessage('Open a Dired buffer to debug link ranges.');
            return;
        }
        const dirHeader = ed.document.lineAt(0).text.replace(/:\s*$/, '').replace(/^Dired:\s*/, '').trim();
        const dir = dirHeader || '.';
        const lines: string[] = [];
        for (let i = 1; i < Math.min(ed.document.lineCount, 200); i++) {
            const line = ed.document.lineAt(i).text;
            if (!line || !line.trim()) continue;
            try {
                const item = FileItem.parseLine(dir, line);
                const fname = item.fileName;
                let startCol = typeof item.startColumn === 'number' ? item.startColumn : line.lastIndexOf(fname);
                // prefer occurrence after time token
                const timeMatch = line.match(/\d{2}:\d{2}/);
                if (timeMatch && typeof timeMatch.index === 'number') {
                    const afterTimeIdx = line.indexOf(fname, timeMatch.index + timeMatch[0].length);
                    if (afterTimeIdx >= 0) startCol = Math.max(startCol, afterTimeIdx);
                }
                lines.push(`${i}: startCol=${startCol} file='${fname}' line='${line}'`);
            } catch (e) {
                /* ignore */
            }
        }
        const out = lines.join('\n');
        const channel = vscode.window.createOutputChannel('Dired Debug');
        channel.clear();
        channel.appendLine(out);
        channel.show(true);
    });
    context.subscriptions.push(commandDebugLinks);

    // When the visible ranges of a Dired editor change (scroll/resize), refresh
    // the provider for that directory so DocumentLinkProvider will regenerate links
    // for the newly visible lines. Debounce per-document to avoid churn while
    // scrolling quickly.
    const _visibleRangeTimers: Map<string, NodeJS.Timeout> = new Map();
    const visibleRangeListener = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        try {
            const doc = e.textEditor.document;
            if (!doc || doc.uri.scheme !== DiredProvider.scheme) return;
            // derive directory from header line (same logic as link provider)
            let header = doc.lineAt(0).text || '';
            header = header.replace(/:\s*$/, '');
            header = header.replace(/^Dired:\s*/, '').trim();
            const dir = header || undefined;
            if (!dir) return;

            const key = doc.uri.toString();
            const prev = _visibleRangeTimers.get(key);
            if (prev) clearTimeout(prev);
            const t = setTimeout(async () => {
                _visibleRangeTimers.delete(key);
                try { await provider.notifyDirChanged(dir as string); } catch (e) { /* ignore */ }
            }, 150);
            _visibleRangeTimers.set(key, t);
        } catch (e) { /* ignore errors */ }
    });
    context.subscriptions.push(visibleRangeListener);

    // Ensure any 'dired' documents opened by clicking links or externally are
    // recognized as `dired` language so DocumentLinkProvider runs immediately.
    const openDocListener = vscode.workspace.onDidOpenTextDocument(async (doc) => {
        try {
            if (doc && doc.uri && doc.uri.scheme === DiredProvider.scheme) {
                await vscode.languages.setTextDocumentLanguage(doc, 'dired');
                // Ensure provider rebuilds cache for this dir so links are ready.
                try { await provider.notifyDirChanged(doc.uri.fsPath); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    });
    context.subscriptions.push(openDocListener);

    // Ensure visible-range timers get cleared when the extension is deactivated
    context.subscriptions.push(new vscode.Disposable(() => {
        try {
            for (const t of _visibleRangeTimers.values()) {
                try { clearTimeout(t); } catch (e) { /* ignore */ }
            }
            _visibleRangeTimers.clear();
        } catch (e) { /* ignore */ }
    }));

    // When a dired document is closed, clear provider buffers to free memory
    const closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
        try {
            if (doc && doc.uri && doc.uri.scheme === DiredProvider.scheme) {
                try { provider.clearBuffers(); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    });
    context.subscriptions.push(closeListener);

    const commandUndo = vscode.commands.registerCommand('extension.dired.undoLastAction', async () => {
        const la = context.workspaceState.get<LastAction>('dired.lastAction') || null;
        if (!la) {
            vscode.window.setStatusBarMessage('No action to undo', 3000);
            return;
        }
        try {
            if (la.type === 'delete') {
                // Restore from backup using module-level helper
                if (la.backup) {
                    await restoreRecursive(la.backup, la.path);
                }
                await context.workspaceState.update('dired.lastAction', null);
                try { await provider.notifyDirChanged(path.dirname(la.path)); } catch {}
                vscode.window.setStatusBarMessage(`Restored ${la.path}`, 5000);
            } else if (la.type === 'create') {
                // Undo create by moving to trash
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.file(la.path), { useTrash: true });
                } catch (e) {
                    try { await fs.promises.unlink(la.path); } catch {}
                }
                await context.workspaceState.update('dired.lastAction', null);
                try { await provider.notifyDirChanged(path.dirname(la.path)); } catch {}
                vscode.window.setStatusBarMessage(`Removed ${la.path}`, 5000);
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Undo failed: ${err}`, 5000);
        }
    });
    context.subscriptions.push(commandUndo);

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        try {
            const scheme = (editor && editor.document && editor.document.uri) ? editor.document.uri.scheme : 'none';
            console.log('Dired: Active editor changed. scheme=' + scheme);
            if (editor && editor.document.uri.scheme === DiredProvider.scheme) {
            editor.options = {
                cursorStyle: vscode.TextEditorCursorStyle.Block,
            };
            vscode.commands.executeCommand('setContext', 'dired.open', true);
            } else {
            vscode.commands.executeCommand('setContext', 'dired.open', false);
        }
        } catch (e) { /* ignore logging or context errors */ }
    });


    return {
        DiredProvider: provider,
    };
}
