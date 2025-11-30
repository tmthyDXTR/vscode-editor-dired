'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import FileItem from './fileItem';
import * as autoBox from './autocompletedInputBox'

const FIXED_URI: vscode.Uri = vscode.Uri.parse('dired://fixed_window');

export default class DiredProvider implements vscode.TextDocumentContentProvider {
    static scheme = 'dired'; // ex: dired://<directory>

    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    // Emit file change events for FileSystemProvider API
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private _fixed_window: boolean;
    private _show_dot_files: boolean = true;
    private _buffers: string[]; // This is a temporary buffer. Reused by multiple tabs.
    private _show_path_in_tab: boolean = false;

    constructor(fixed_window: boolean) {
        this._fixed_window = fixed_window;
        const cfg = vscode.workspace.getConfiguration('dired');
        if (cfg.has('show_path_in_tab')) {
            this._show_path_in_tab = cfg.get('show_path_in_tab') as boolean;
        }
    }

    dispose() {
        this._onDidChange.dispose();
    }

    get onDidChange() {
        return this._onDidChange.event;
    }

    // FileSystemProvider event
    get onDidChangeFile() {
        return this._onDidChangeFile.event;
    }

    get dirname() {
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return undefined;
        }
        const doc = at.document;
        if (!doc) {
            return undefined;
        }
        const line0 = doc.lineAt(0).text;
        // Header may be of the form "Dired: <dir>:" or simply "<dir>:" for backward compatibility.
        let header = line0.substring(0, line0.length - 1);
        header = header.replace(/^Dired:\s*/, '');
        // Trim whitespace
        const dir = header.trim();
        return dir;
    }

    toggleDotFiles() {
        this._show_dot_files = !this._show_dot_files;
        this.reload();
    }

    enter() {
        const f = this.getFile();
        if (!f) {
            return;
        }
        const uri = f.uri;
        if (!uri) {
            return;
        }
        // If the user pressed Enter on the parent entry, go up one directory
        if (f.fileName === '..') {
            this.goUpDir();
            return;
        }
        if (uri.scheme !== DiredProvider.scheme) {
            this.showFile(uri);
            return;
        }
        this.openDir(f.path);
    }

    reload() {
        if (!this.dirname) {
            return;
        }
        this.createBuffer(this.dirname)
            .then(() => this._onDidChange.fire(this.uri));
    }

    // --- Minimal FileSystemProvider implementations so dired:// documents become editable ---
    // These are deliberately minimal: enough for VS Code to treat the `dired` scheme as writable
    // and to let us detect and apply filename changes when the buffer is saved.

    // Watch notifications - not fully implemented (no-op watcher)
    watch(_resource: vscode.Uri, _opts: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // Not implementing fine-grained watching for now
        return new vscode.Disposable(() => { });
    }

    // Return file stat for the dired virtual file (we report it as a file)
    stat(resource: vscode.Uri): vscode.FileStat {
        return {
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: this._buffers ? Buffer.from(this._buffers.join('\n')).length : 0
        };
    }

    // readDirectory is not used by the extension but implement a safe default
    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        return [];
    }

    // When opening a dired://<dir> document, VS Code calls readFile. Return the rendered listing.
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const dir = uri.fsPath;
        await this.createBuffer(dir);
        const content = this._buffers.join('\n');
        return Buffer.from(content, 'utf8');
    }

    // When the user saves the dired buffer, VS Code will call writeFile with the new content.
    // We compare the new contents against the current directory listing and apply renames
    // for lines whose filename column (from col 52) changed.
    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const dir = uri.fsPath;
        // Ensure current buffer reflects actual FS state before compare
        await this.createBuffer(dir);
        const oldLines = this._buffers.slice();
        const newText = Buffer.from(content).toString('utf8');
        const newLines = newText.split(/\r?\n/);

        // Align lengths by padding with empty strings if needed
        const maxLines = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLines; i++) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';
            // Only consider data lines (skip header line 0)
            if (i === 0) continue;
            if (!oldLine && !newLine) continue;

            // Extract filename portion (column 52 onwards) using same logic as FileItem.parseLine
            const oldName = (oldLine.length >= 52) ? oldLine.substring(52) : '';
            const newName = (newLine.length >= 52) ? newLine.substring(52) : '';

            if (oldName && newName && oldName !== newName) {
                const oldPath = path.join(dir, oldName);
                const newPath = path.join(dir, newName);
                try {
                    // Perform rename on filesystem
                    await fs.promises.rename(oldPath, newPath);
                    vscode.window.showInformationMessage(`${oldName} -> ${newName}`);
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to rename ${oldName} -> ${newName}: ${err}`);
                }
            }
        }

        // Rebuild buffer from FS and notify content changed
        await this.createBuffer(dir);
        this._onDidChange.fire(uri);
        // Emit file change events for consumers
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    // createDirectory - forwards to fs
    async createDirectory(uri: vscode.Uri): Promise<void> {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
    }

    // delete - support deleting a dired virtual file (not used by UI)
    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        if (options.recursive) {
            await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
        } else {
            await fs.promises.unlink(uri.fsPath);
        }
    }

    // rename - forward to fs and notify
    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        if (options.overwrite) {
            try { await fs.promises.unlink(newUri.fsPath); } catch { /* ignore */ }
        }
        await fs.promises.rename(oldUri.fsPath, newUri.fsPath);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: newUri }]);
    }

    async createDir(dirname: string) {
        if (this.dirname) {
            const p = path.join(this.dirname, dirname);
            let uri = vscode.Uri.file(p);
            await vscode.workspace.fs.createDirectory(uri);
            this.reload();
        }
    }

    async createFile(filename: string) {
        const uri = vscode.Uri.file(filename);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        this.reload();
    }

    renameSelected(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const n = path.join(this.dirname, newName);
            this.reload();
            vscode.window.showInformationMessage(`${f.fileName} is renamed to ${n}`);
        }
    }

    copySelected(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const n = path.join(this.dirname, newName);
            vscode.window.showInformationMessage(`${f.fileName} is copied to ${n}`);
        }
    }
    deleteSelected() {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const n = path.join(this.dirname, f.fileName);
            fs.unlinkSync(n);
            this.reload();
            vscode.window.showInformationMessage(`${n} was deleted`);
        }
    }

    select() {
        this.selectFiles(true);
    }

    unselect() {
        this.selectFiles(false);
    }

    goUpDir() {
        if (!this.dirname || this.dirname === "/") {
            return;
        }
        // Resolve the parent path and open it in-place
        const p = path.resolve(this.dirname, "..");
        this.openDir(p);
    }

    openDir(dirPath: string) {
        // Build URI for the directory. Always use a per-directory label URI so the tab title reflects
        // the directory path, but if `fixed_window` is enabled, close other dired editors so we still
        // have a single Dired tab.
        // If `fixed_window` is true and `show_path_in_tab` is false, reuse FIXED_URI so the same
        // editor instance is used across directories. If `show_path_in_tab` is true, use a path
        // URI so the tab shows the path; we will close other dired editors to keep a single tab.
        const uri = (this._fixed_window && !this._show_path_in_tab) ? FIXED_URI : this.createPathUriForDir(dirPath);
        if (uri) {
            this.createBuffer(dirPath)
                .then(() => {
                    // Notify VS Code that content for this virtual document changed
                    this._onDidChange.fire(uri);
                    return vscode.workspace.openTextDocument(uri);
                })
                .then(doc => vscode.window.showTextDocument(doc, this.getTextDocumentShowOptions(this._fixed_window)))
                .then(editor => {
                    try {
                        vscode.languages.setTextDocumentLanguage(editor.document, "dired");
                    } catch (e) { }
                    // Move the cursor to the filename column (matches parseLine offset)
                    const filenameColumn = 52;
                    const targetLine = (editor.document.lineCount > 1) ? 1 : 0;
                    try {
                        const pos = new vscode.Position(targetLine, filenameColumn);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    } catch (e) {
                        // ignore if position is out of range
                    }
                    // When fixed_window is enabled, ensure only one Dired editor tab exists by closing other
                    // Dired editors that are not this one. This preserves the "single Dired tab" behavior
                    // while still showing the directory path in the tab title.
                    if (this._fixed_window) {
                        // Close other dired editors, exempting the one we opened. If `show_path_in_tab` is
                        // enabled, we'll exempt the URI we just created (which is a per-directory URI),
                        // otherwise we exempt FIXED_URI.
                        const exempt = this._show_path_in_tab ? editor.document.uri : FIXED_URI;
                        this.closeOtherDiredEditors(exempt);
                    }
                });
        }
    }

    private createPathUriForDir(dir: string): vscode.Uri {
        // Use a file-style path URI but with the dired scheme so the tab title shows the path.
        return vscode.Uri.file(dir).with({ scheme: DiredProvider.scheme });
    }

    showFile(uri: vscode.Uri) {
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc, this.getTextDocumentShowOptions(false));
        });
        // TODO: show warning when open file failed
        // vscode.window.showErrorMessage(`Could not open file ${uri.fsPath}: ${err}`);
    }

    provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
        return this.render();
    }

    private get uri(): vscode.Uri {
        // For fixed window, return FIXED_URI unless the user requested the path be shown in the tab.
        if (this._fixed_window && !this._show_path_in_tab) {
            return FIXED_URI;
        }
        // For non-fixed windows, return a per-directory URI so each open tab displays its path.
        const dir = this.dirname;
        if (!dir) {
            return FIXED_URI;
        }
        return vscode.Uri.file(dir).with({ scheme: DiredProvider.scheme });
    }

    // Return the filesystem path of the currently selected item in the active Dired buffer.
    public getSelectedPath(): string | null {
        const f = this.getFile();
        if (!f) {
            // Cursor on header or no file selected -> return current directory path
            const d = this.dirname || '.';
            return path.resolve(d);
        }
        // If the user selected '.' or '..', return the parent/dir instead of '.' literal
        if (f.fileName === '.' || f.fileName === '..') {
            return path.resolve(this.dirname || '.');
        }
        return path.resolve(f.path || '.');
    }

    private render(): Thenable<string> {
        return new Promise((resolve) => {
            resolve(this._buffers.join('\n'));
        });
    }

    private createBuffer(dirname: string): Thenable<string[]> {
        return new Promise((resolve) => {
            let files: FileItem[] = [];
            if (fs.statSync(dirname).isDirectory()) {
                try {
                    files = this.readDir(dirname);
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not read ${dirname}: ${err}`);
                }
                    
            }

            this._buffers = [
                `${dirname}:`, // header line - only show the path
            ];
            this._buffers = this._buffers.concat(files.map((f) => f.line()));

            resolve(this._buffers);
        });
    }

    private async closeOtherDiredEditors(exemptUri: vscode.Uri) {
        // If the Tabs API is available, use it to close tabs without changing focus or showing them
        const anyWindow = (vscode.window as any);
        if (anyWindow && anyWindow.tabGroups && typeof anyWindow.tabGroups.close === 'function') {
            const tabsToClose: any[] = [];
            for (const group of anyWindow.tabGroups.all) {
                for (const tab of group.tabs) {
                    // Tab input might be of the form { uri }
                    const inputUri = tab.input && tab.input.uri;
                    if (inputUri && inputUri.scheme === DiredProvider.scheme && inputUri.toString() !== exemptUri.toString()) {
                        tabsToClose.push(tab);
                    }
                }
            }
            if (tabsToClose.length) {
                try {
                    await anyWindow.tabGroups.close(tabsToClose, true);
                }
                catch (err) { /* ignore errors */ }
            }
            return;
        }

        // Fallback: iterate through visibleTextEditors first, close those with preserveFocus true to
        // reduce flicker. This won't close editors that are not visible.
        for (const e of vscode.window.visibleTextEditors) {
            const u = e.document.uri;
            if (u && u.scheme === DiredProvider.scheme && u.toString() !== exemptUri.toString()) {
                try {
                    /* eslint-disable @typescript-eslint/no-floating-promises */
                    // Show without focus change; then close the active editor.
                    await vscode.window.showTextDocument(e.document, { viewColumn: e.viewColumn, preserveFocus: true, preview: false });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                } catch (err) { /* ignore */ }
            }
        }

        // Also try to close other Dired documents that aren't visible (best-effort). These may lead to focus
        // changes depending on VS Code behavior, so they are done after visible ones.
        for (const doc of vscode.workspace.textDocuments) {
            const u = doc.uri;
            if (u && u.scheme === DiredProvider.scheme && u.toString() !== exemptUri.toString()) {
                try {
                    /* eslint-disable @typescript-eslint/no-floating-promises */
                    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                } catch (err) { /* ignore */ }
            }
        }
    }

    private readDir(dirname: string): FileItem[] {
        const files = [".", ".."].concat(fs.readdirSync(dirname));
        return <FileItem[]>files.map((filename) => {
            const p = path.join(dirname, filename);
            try {
                const stat = fs.statSync(p);
                return FileItem.create(dirname, filename, stat);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not get stat of ${p}: ${err}`);
                return null;
            }
        }).filter((fileItem) => {
            if (fileItem) {
                if (this._show_dot_files) return true;
                let filename = fileItem.fileName;
                if (filename == '..' || filename == '.') return true;
                return filename.substring(0, 1) != '.';
            } else {
                return false;
            }
        });
    }

    private getFile(): FileItem | null {
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return null;
        }
        const cursor = at.selection.active;
        if (cursor.line < 1) {
            return null;
        }
        const lineText = at.document.lineAt(cursor.line);
        if (this.dirname && lineText) {
            return FileItem.parseLine(this.dirname, lineText.text);
        }
        return null;
    }

    private selectFiles(value: boolean) {
        if (!this.dirname) {
            return;
        }
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return;
        }
        const doc = at.document;
        if (!doc) {
            return;
        }
        this._buffers = [];
        for (let i = 0; i < doc.lineCount; i++) {
            this._buffers.push(doc.lineAt(i).text);
        }

        let start = 0;
        let end = 0;
        let allowSelectDot = false; // Want to copy emacs's behavior exactly

        if (at.selection.isEmpty) {
            const cursor = at.selection.active;
            if (cursor.line === 0) { // Select all
                start = 1;
                end = doc.lineCount;
            } else {
                allowSelectDot = true;
                start = cursor.line;
                end = cursor.line + 1;
                vscode.commands.executeCommand("cursorMove", { to: "down", by: "line" });
            }
        } else {
            start = at.selection.start.line;
            end = at.selection.end.line;
        }

        for (let i = start; i < end; i++) {
            const f = FileItem.parseLine(this.dirname, this._buffers[i]);
            if (f.fileName === "." || f.fileName === "..") {
                if (!allowSelectDot) {
                    continue;
                }
            }
            f.select(value);
            this._buffers[i] = f.line();
        }
        const uri = this.uri;
        this._onDidChange.fire(uri);
    }

    private getTextDocumentShowOptions(fixed_window: boolean): vscode.TextDocumentShowOptions {
        const opts: vscode.TextDocumentShowOptions = {
            preview: fixed_window,
            viewColumn: vscode.ViewColumn.Active
        };
        return opts;
    }
}
