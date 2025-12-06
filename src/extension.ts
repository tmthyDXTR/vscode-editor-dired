import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import FileItem from "./fileItem";
import DiredProvider from "./provider";
import { autocompletedInputBox } from "./autocompletedInputBox";

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
    const ask_dir = cfg.get<boolean>("ask_dir") || false;

    const provider = new DiredProvider(fixed_window);

    // Persistent status bar item for last action with undo
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'extension.dired.undoLastAction';
    context.subscriptions.push(statusItem);

    // Last action state (persist across reloads in workspaceState)
    type LastAction = { type: 'delete'|'create', path: string, backup?: string, isDirectory?: boolean } | null;
    let lastAction: LastAction = context.workspaceState.get('dired.lastAction') || null;
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
    const providerRegistrations = vscode.Disposable.from(
        // Cast to `any` to satisfy the TS signature while keeping the class in one place.
        vscode.workspace.registerFileSystemProvider(DiredProvider.scheme, provider as any, { isCaseSensitive: true }),
    );
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
                vscode.window.showInputBox({ value: dir, valueSelection: [dir.length, dir.length] })
                        .then(async (path) => {
                            if (!path) {
                                return;
                            }
                            try {
                                const st = await fs.promises.stat(path);
                                if (st.isDirectory()) {
                                    provider.openDir(path);
                                    return;
                                }
                                if (st.isFile()) {
                                    const f = new FileItem(path, "", false, true); // Incomplete FileItem just to get URI.
                                    const uri = f.uri;
                                    if (uri) provider.showFile(uri);
                                    return;
                                }
                            } catch (e) {
                                // ignore stat errors
                            }
                        });
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
        let dirName = await vscode.window.showInputBox({ prompt: "Directory name" });
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
            // update status item
            // reuse setLastAction by fetching the function via closure: recreate by explicitly calling
            // But setLastAction not accessible here; instead reuse workspaceState and show statusItem
            // We'll set status text directly
            try { statusItem.text = `$(plus) Created ${path.basename(p)} — Undo`; statusItem.tooltip = `Remove ${p}`; statusItem.show(); } catch {}
            vscode.window.setStatusBarMessage(`Created ${p}`, 3000);
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to create directory ${p}: ${err}`, 5000);
        }
    });
    const commandOpenTerminal = vscode.commands.registerCommand("extension.dired.openTerminal", async () => {
        try {
            const selectedCandidate = provider.getSelectedPath();
            const fallback = provider.dirname || os.homedir();
            let selected: string = selectedCandidate ? selectedCandidate : fallback;
            let cwd: string = selected;
            try {
                const stat = await fs.promises.stat(selected);
                if (stat.isFile()) cwd = path.dirname(selected);
            } catch (e) { cwd = fallback; }
            try {
                const term = vscode.window.createTerminal({ cwd: cwd as any, name: `dired: ${path.basename(cwd)}`, location: { viewColumn: vscode.ViewColumn.Active } as any } as any);
                // Focus the terminal so keyboard input can be typed directly
                term.show(false);
                vscode.window.setStatusBarMessage(`Opened terminal in ${cwd}`, 3000);
            } catch (e) {
                const fallbackTerm = vscode.window.createTerminal({ cwd: cwd, name: `dired: ${path.basename(cwd)}` });
                // Focus fallback terminal explicitly as well
                fallbackTerm.show(false);
                vscode.window.setStatusBarMessage(`Opened terminal in ${cwd}`, 3000);
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to open terminal: ${err}`, 5000);
        }
    });
    const commandRename = vscode.commands.registerCommand("extension.dired.rename", () => {
        vscode.window.showInputBox()
            .then((newName: string) => {
                provider.renameSelected(newName);
            });
    });
    const commandCopy = vscode.commands.registerCommand("extension.dired.copy", () => {
        // Ensure there's a selected file/folder in the active dired buffer before prompting
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

        // Determine selected path
        const selected = provider.getSelectedPath();
        const cwd = provider.dirname;
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
                    try { await fs.promises.rm(selected, { recursive: true, force: true }); } catch { try { await fs.promises.rmdir(selected, { recursive: true }); } catch {} }
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
        let fileName = await autocompletedInputBox(
            {
                completion: completionFunc,
                withSelf: processSelf,
            });
        // Show chosen filename in the status bar rather than popup
        if (fileName) vscode.window.setStatusBarMessage(`${fileName}`, 3000);
        let isDirectory = false;

        try {
            let stat = await fs.promises.stat(fileName);
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
        commandGoUpDir,
        commandCopyName,
        commandRefresh,
        commandClose,
        commandDelete,
        commandSelect,
        providerRegistrations
    );
    context.subscriptions.push(commandCopyPath);

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
        const la: any = context.workspaceState.get('dired.lastAction') || null;
        if (!la) {
            vscode.window.setStatusBarMessage('No action to undo', 3000);
            return;
        }
        try {
            if (la.type === 'delete') {
                // Restore from backup using module-level helper
                await restoreRecursive(la.backup, la.path);
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
