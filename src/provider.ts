'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import FileItem from './fileItem';
import * as autoBox from './autocompletedInputBox'

// Reuse encoder/decoder instances to avoid allocating them repeatedly in hot paths
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Move common recursive copy helper to module scope so the function object
// isn't reallocated every time it's used by methods like `copySelected`.
async function copyRecursiveHelper(srcPath: string, destPath: string) {
    const sstat = await fs.promises.stat(srcPath);
    if (sstat.isDirectory()) {
        await fs.promises.mkdir(destPath, { recursive: true });
        for (const name of await fs.promises.readdir(srcPath)) {
            await copyRecursiveHelper(path.join(srcPath, name), path.join(destPath, name));
        }
    } else {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(srcPath, destPath);
    }
}

const FIXED_URI: vscode.Uri = vscode.Uri.parse('dired://fixed_window');

export default class DiredProvider implements vscode.TextDocumentContentProvider {
    static scheme = 'dired'; // ex: dired://<directory>

    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    // Emit file change events for FileSystemProvider API
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private _fixed_window: boolean;
    private _show_dot_files: boolean = true;
    // Toggle display of `.meta` files (e.g., Unity .meta files)
    private _show_meta_files: boolean = true;
    private _buffers: string[]; // This is a temporary buffer. Reused by multiple tabs.
    private _show_path_in_tab: boolean = false;
    private _watcher: vscode.FileSystemWatcher | null = null;
    // Lightweight per-directory cache to store minimal file metadata and avoid
    // retaining heavy FileItem or formatted-line objects between operations.
    // Each cache entry stores { entries: Array, dirMtime?: number } so we can
    // validate freshness against the directory mtime before reusing.
    private _dirCache: Map<string, { entries: Array<any>, dirMtime?: number }> = new Map();
    // debounce timers for watchers to coalesce rapid FS events
    private _watchDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(fixed_window: boolean) {
        this._fixed_window = fixed_window;
        const cfg = vscode.workspace.getConfiguration('dired');
        if (cfg.has('show_path_in_tab')) {
            this._show_path_in_tab = cfg.get('show_path_in_tab') as boolean;
        }
    }

    dispose() {
        this._onDidChange.dispose();
        try { if (this._watcher) { this._watcher.dispose(); this._watcher = null; } } catch (e) { }
        try {
            // Clear any pending debounce timers to avoid retaining closures
            for (const t of this._watchDebounceTimers.values()) {
                try { clearTimeout(t); } catch (e) { /* ignore */ }
            }
            this._watchDebounceTimers.clear();
            // Clear per-dir cache to release memory
            try { this._dirCache.clear(); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }

    // Clear any in-memory buffers held by the provider to free memory.
    public clearBuffers() {
        try {
            this._buffers = [];
            // Also free any cached per-directory metadata to reduce retained memory.
            try { this._dirCache.clear(); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
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

    async toggleDotFiles() {
        this._show_dot_files = !this._show_dot_files;
        // If we can resolve the current directory, notify that directory changed so
        // both the per-directory URI and the active Dired URI (fixed_window support)
        // get refreshed. Fall back to reload() if dirname is not available.
        const dir = this.dirname;
        // Ensure cache no longer serves stale listings which don't reflect the
        // updated `_show_dot_files` value. Delete the per-dir cache entry so
        // `createBuffer` will rebuild the listing taking `_show_dot_files` into
        // account. If `dir` is not set, clear all caches to be safe.
        try {
            if (dir) {
                this._dirCache.delete(dir);
            } else {
                this._dirCache.clear();
            }
        } catch (e) { /* ignore cache deletion errors */ }
        if (dir) {
            await this.notifyDirChanged(dir);
        } else {
            this.reload();
        }
    }

    async toggleMetaFiles() {
        this._show_meta_files = !this._show_meta_files;
        const dir = this.dirname;
        // Clear cache for the current dir or all to ensure listing rebuild reflects meta visibility
        try {
            if (dir) this._dirCache.delete(dir);
            else this._dirCache.clear();
        } catch (e) { /* ignore */ }
        if (dir) {
            await this.notifyDirChanged(dir);
        } else {
            this.reload();
        }
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
            // compute size without creating an intermediate Buffer to reduce memory churn
            size: this._buffers ? TEXT_ENCODER.encode(this._buffers.join('\n')).length : 0
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
        // Return a Uint8Array. Buffer is a Uint8Array at runtime but some TS settings
        // (lib/DOM/SharedArrayBuffer differences) can make the types incompatible.
        // Use TextEncoder to produce a proper Uint8Array instead of relying on Buffer.
        return TEXT_ENCODER.encode(content);
    }

    // When the user saves the dired buffer, VS Code will call writeFile with the new content.
    // We compare the new contents against the current directory listing and apply renames
    // for lines whose filename column (from col 52) changed.
    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const dir = uri.fsPath;
        // Ensure current buffer reflects actual FS state before compare
        await this.createBuffer(dir);
        const oldLines = this._buffers.slice();
        // decode without allocating an intermediate Node Buffer
        const newText = TEXT_DECODER.decode(content);
        const newLines = newText.split(/\r?\n/);

        // Align lengths by padding with empty strings if needed
        const maxLines = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLines; i++) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';
            // Only consider data lines (skip header line 0)
            if (i === 0) continue;
            if (!oldLine && !newLine) continue;

            // Extract filename portion using FileItem.parseLine (robust to field sizes)
            let oldName = '';
            let newName = '';
            try {
                const oldItem = FileItem.parseLine(dir, oldLine);
                oldName = oldItem ? oldItem.fileName : '';
            } catch (e) { /* ignore */ }
            try {
                const newItem = FileItem.parseLine(dir, newLine);
                newName = newItem ? newItem.fileName : '';
            } catch (e) { /* ignore */ }

            if (oldName && newName && oldName !== newName) {
                const oldPath = path.join(dir, oldName);
                const newPath = path.join(dir, newName);
                try {
                    // Perform rename on filesystem
                    await fs.promises.rename(oldPath, newPath);
                    vscode.window.setStatusBarMessage(`${oldName} -> ${newName}`, 3000);
                } catch (err) {
                    vscode.window.setStatusBarMessage(`Failed to rename ${oldName} -> ${newName}: ${err}`, 5000);
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
        const cwd = this.dirname;
        if (!cwd) return;
        const p = path.join(cwd, dirname);
        const createdUri = vscode.Uri.file(p);
        // Create directory and refresh listing for the captured cwd
        try {
            await vscode.workspace.fs.createDirectory(createdUri);
        } catch (err) {
            // Fallback to fs if workspace API fails for some reason
            await fs.promises.mkdir(p, { recursive: true });
        }
        // Rebuild buffer for cwd and notify change for that specific URI
        await this.createBuffer(cwd as string);
        const uri = this.createPathUriForDir(cwd as string);
        this._onDidChange.fire(uri);
        // Also emit a file-change event so consumers and any watchers update immediately
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        // Also notify the active Dired URI (handles fixed_window mode where the editor uses FIXED_URI)
        try {
            const activeUri = this.uri;
            if (activeUri && activeUri.toString() !== uri.toString()) {
                this._onDidChange.fire(activeUri);
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: activeUri }]);
            }
        } catch (e) { /* ignore */ }
    }

    async createFile(filename: string) {
        // Resolve filename against current dired directory if relative
        const cwd = this.dirname;
        let target = filename;
        if (!path.isAbsolute(target)) {
            if (!cwd) {
                vscode.window.setStatusBarMessage('Cannot determine current directory to create file in.', 5000);
                return;
            }
            target = path.join(cwd, target);
        }

        // Create parent directories and the file (if it doesn't exist), then refresh the listing for cwd
        try {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            try {
                await fs.promises.access(target, fs.constants.F_OK);
                // file exists - do nothing
            } catch (e) {
                await fs.promises.writeFile(target, "");
            }
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to create file ${target}: ${err}`, 5000);
            return;
        }

        const listDir = cwd || path.dirname(target);
        await this.createBuffer(listDir);
        const uri = this.createPathUriForDir(listDir);
        this._onDidChange.fire(uri);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        // Also notify the active Dired URI to cover fixed_window mode
        try {
            const activeUri = this.uri;
            if (activeUri && activeUri.toString() !== uri.toString()) {
                this._onDidChange.fire(activeUri);
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: activeUri }]);
            }
        } catch (e) { /* ignore */ }
    }

    renameSelected(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const n = path.join(this.dirname, newName);
            this.reload();
            vscode.window.setStatusBarMessage(`${f.fileName} is renamed to ${n}`, 3000);
        }
    }

    copySelected(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (!this.dirname) return;
        if (!newName) return;
        const src = path.join(this.dirname, f.fileName);
        let dest = newName;
        if (!path.isAbsolute(dest)) {
            dest = path.join(this.dirname, dest);
        }

        // Use module-scoped helper to avoid recreating the function on each call
        const copyRecursive = copyRecursiveHelper;

        const cwd = this.dirname;
        (async () => {
            try {
            await copyRecursive(src, dest);
            // Refresh the specific directory buffer we modified
            await this.createBuffer(cwd as string);
            const uri = this.createPathUriForDir(cwd as string);
                this._onDidChange.fire(uri);
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                try {
                    const activeUri = this.uri;
                    if (activeUri && activeUri.toString() !== uri.toString()) {
                        this._onDidChange.fire(activeUri);
                        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: activeUri }]);
                    }
                } catch (e) { /* ignore */ }
                vscode.window.setStatusBarMessage(`${src} copied to ${dest}`, 3000);
            } catch (err) {
                vscode.window.setStatusBarMessage(`Failed to copy ${src} -> ${dest}: ${err}`, 5000);
            }
        })();
    }
    async deleteSelected() {
        const f = this.getFile();
        if (!f) {
            return;
        }
        const cwd = this.dirname;
        if (!cwd) {
            return;
        }
        const target = path.join(cwd, f.fileName);
        try {
            const stat = await fs.promises.stat(target);
            if (stat.isDirectory()) {
                try {
                    await fs.promises.rm(target, { recursive: true, force: true });
                } catch (e) {
                    try { await fs.promises.rmdir(target, { recursive: true } as any); } catch {}
                }
            } else {
                try { await fs.promises.unlink(target); } catch {}
            }
            // Refresh the specific directory buffer we modified
            await this.createBuffer(cwd as string);
            const uri = this.createPathUriForDir(cwd as string);
            this._onDidChange.fire(uri);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            // Also notify the active Dired URI to cover fixed_window mode
            try {
                const activeUri = this.uri;
                if (activeUri && activeUri.toString() !== uri.toString()) {
                    this._onDidChange.fire(activeUri);
                    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: activeUri }]);
                }
            } catch (e) { /* ignore */ }
            vscode.window.setStatusBarMessage(`${target} was deleted`, 3000);
        } catch (err) {
            vscode.window.setStatusBarMessage(`Failed to delete ${target}: ${err}`, 5000);
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
        if (!uri) return;

        // Open the dired document. readFile will call createBuffer when the document is read,
        // so avoid pre-populating the buffer here to prevent duplicate heavy allocations.
        vscode.workspace.openTextDocument(uri)
            .then(async (doc) => {
                try { await vscode.languages.setTextDocumentLanguage(doc, 'dired'); } catch (e) { /* ignore */ }
                return vscode.window.showTextDocument(doc, this.getTextDocumentShowOptions(this._fixed_window));
            })
            .then(editor => {
                try { vscode.languages.setTextDocumentLanguage(editor.document, "dired"); } catch (e) { }
                // Move the cursor to the filename column (compute dynamically)
                try {
                    const targetLine = (editor.document.lineCount > 1) ? 1 : 0;
                    const text = editor.document.lineAt(targetLine).text;
                    let startCol = 52; // fallback
                    try {
                        const item = FileItem.parseLine(this.dirname || '.', text);
                        if (item && item.fileName) {
                            // Prefer the parsed start column if available
                            if (typeof item.startColumn === 'number') {
                                startCol = item.startColumn;
                            } else {
                                const idx = text.lastIndexOf(item.fileName);
                                if (idx >= 0) startCol = idx;
                            }
                            // Heuristic: prefer the occurrence of filename that happens after the HH:MM token
                            try {
                                const timeMatch = text.match(/\d{2}:\d{2}/);
                                if (timeMatch && typeof timeMatch.index === 'number') {
                                    // Find the first non-space position after the time token
                                        let pos = timeMatch.index + timeMatch[0].length;
                                        while (pos < text.length && text.charAt(pos) === ' ') pos++;
                                        if (pos < text.length) startCol = pos;
                                }
                            } catch (e) { /* ignore */ }
                        }
                    } catch (e) { /* ignore */ }
                    const pos = new vscode.Position(targetLine, startCol);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                } catch (e) { /* ignore */ }

                if (this._fixed_window) {
                    const exempt = this._show_path_in_tab ? editor.document.uri : FIXED_URI;
                    this.closeOtherDiredEditors(exempt).then(undefined, () => { /* ignore */ });
                }

                // Setup a FileSystemWatcher for this open directory so external changes
                // (create/delete/modify) cause the listing to refresh automatically.
                try { this.setupWatcher(dirPath); } catch (e) { /* ignore */ }
            }).then(undefined, () => { /* ignore open errors */ });
    }

    private setupWatcher(dir: string) {
        // Dispose previous watcher if any
        try {
            if (this._watcher) {
                this._watcher.dispose();
                this._watcher = null;
            }
        } catch (e) { /* ignore */ }

        try {
            const pattern = new vscode.RelativePattern(dir, '**');
            this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
            // Debounce rapid events so bursts coalesce into a single refresh
            const schedule = () => {
                const prev = this._watchDebounceTimers.get(dir);
                if (prev) clearTimeout(prev);
                const t = setTimeout(async () => {
                    this._watchDebounceTimers.delete(dir);
                    try { await this.notifyDirChanged(dir); } catch (e) { /* ignore */ }
                }, 200);
                this._watchDebounceTimers.set(dir, t);
            };
            this._watcher.onDidCreate(schedule);
            this._watcher.onDidChange(schedule);
            this._watcher.onDidDelete(schedule);
        } catch (e) {
            // ignore watcher failures (some environments may restrict watchers)
            try { if (this._watcher) { this._watcher.dispose(); this._watcher = null; } } catch (ee) { }
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

    // Expose current flags so callers can display status messages after toggles
    public get showDotFiles(): boolean {
        return this._show_dot_files;
    }

    public get showMetaFiles(): boolean {
        return this._show_meta_files;
    }

    private render(): Thenable<string> {
        return new Promise((resolve) => {
            resolve(this._buffers.join('\n'));
        });
    }

    private async createBuffer(dirname: string): Promise<string[]> {
        const buffers: string[] = [];
        buffers.push(`${dirname}:`);

        // Configurable safety cap for huge directories
        const cfg = vscode.workspace.getConfiguration('dired');
        const MAX_ENTRIES = cfg.get<number>('maxEntries') || 5000;

        try {
            const st = await fs.promises.stat(dirname);
            if (!st.isDirectory()) {
                this._buffers = buffers;
                return this._buffers;
            }
        } catch (e) {
            this._buffers = buffers;
            return this._buffers;
        }

        try {
            const entries = await fs.promises.readdir(dirname);
            // Fast-path: if we have a recent lightweight cache for this directory,
            // validate it against the directory mtime and reuse it to avoid
            // re-statting all files. This greatly reduces work when reopening the
            // same dired buffer. If the directory mtime differs, fall through to
            // rebuild the listing so new files/deletes are picked up.
            const cachedEntry = this._dirCache.get(dirname);
            if (cachedEntry && Array.isArray(cachedEntry.entries) && cachedEntry.entries.length > 0) {
                try {
                    // Check directory mtime to ensure cache freshness
                    try {
                        const dst = await fs.promises.stat(dirname);
                        const mtime = (dst && typeof (dst.mtimeMs) === 'number') ? dst.mtimeMs : dst.mtime.getTime();
                        if (cachedEntry.dirMtime === mtime) {
                            const lines = cachedEntry.entries.map((e) => {
                                const f = new FileItem(dirname, e.filename, e.isDirectory, e.isFile, e.username, e.groupname, e.size, e.month, e.day, e.hour, e.min, e.modeStr, e.selected);
                                return f.line();
                            });
                            this._buffers = buffers.concat(lines);
                            if (cachedEntry.entries.length > MAX_ENTRIES) {
                                this._buffers.push(`(listing truncated to ${MAX_ENTRIES} entries)`);
                            }
                            return this._buffers;
                        }
                        // mtime differs -> fallthrough to rebuild cache
                    } catch (e) {
                        // if stat failed, ignore and rebuild
                    }
                } catch (e) {
                    // If cache regeneration fails for any reason, fall through to rebuild.
                }
            }
            // include '.' and '..' similar to previous behavior
            let names = ['.', '..', ...entries];

            // Honor the `_show_dot_files` flag: when false, filter out entries
            // starting with '.' except for '.' and '..'. This mirrors the
            // behavior implemented in `readDir` and ensures toggling dotfiles
            // updates the displayed listing.
            if (!this._show_dot_files) {
                names = names.filter((n) => n === '.' || n === '..' || n.charAt(0) !== '.');
            }
            // Honor `_show_meta_files`: when false, filter out files that end with '.meta'
            if (!this._show_meta_files) {
                names = names.filter((n) => n === '.' || n === '..' || !n.toLowerCase().endsWith('.meta'));
            }

            let truncated = false;
            if (names.length > MAX_ENTRIES) {
                names = names.slice(0, MAX_ENTRIES);
                truncated = true;
            }

            // Build a lightweight cached representation to avoid holding onto
            // FileItem instances or long formatted strings between operations.
            const lightEntries: Array<any> = [];
            for (const filename of names) {
                const p = path.join(dirname, filename);
                try {
                    const stat = await fs.promises.stat(p);
                    const fi = FileItem.create(dirname, filename, stat);
                    if (!fi) continue;
                    // Store minimal fields needed to re-create a FileItem on demand
                    lightEntries.push({
                        filename: fi.fileName,
                        isDirectory: (fi as any)._isDirectory,
                        isFile: (fi as any)._isFile,
                        username: (fi as any)._username,
                        groupname: (fi as any)._groupname,
                        size: (fi as any)._size,
                        month: (fi as any)._month,
                        day: (fi as any)._day,
                        hour: (fi as any)._hour,
                        min: (fi as any)._min,
                        modeStr: (fi as any)._modeStr,
                        selected: false
                    });
                } catch (err) {
                    // skip entries we can't stat
                }
            }

            // Save to per-directory cache (LRU by insertion order). Capture directory mtime
            // so future reads can validate freshness and avoid serving stale listings.
            try {
                let dirMtime: number | undefined = undefined;
                try {
                    const dst = await fs.promises.stat(dirname);
                    dirMtime = (dst && typeof (dst.mtimeMs) === 'number') ? dst.mtimeMs : dst.mtime.getTime();
                } catch (e) { /* ignore stat errors for cache mtime */ }
                this._dirCache.set(dirname, { entries: lightEntries, dirMtime });
                const MAX_CACHE_DIRS = 10;
                while (this._dirCache.size > MAX_CACHE_DIRS) {
                    // delete oldest entry (Map preserves insertion order)
                    const k = this._dirCache.keys().next().value;
                    this._dirCache.delete(k);
                }
            } catch (e) { /* ignore cache errors */ }

            // Recreate formatted lines on demand from the lightweight entries.
            const lines = lightEntries.map((e) => {
                const f = new FileItem(dirname, e.filename, e.isDirectory, e.isFile, e.username, e.groupname, e.size, e.month, e.day, e.hour, e.min, e.modeStr, e.selected);
                return f.line();
            });

            this._buffers = buffers.concat(lines);
            if (truncated) {
                this._buffers.push(`(listing truncated to ${MAX_ENTRIES} entries)`);
            }
            return this._buffers;
        } catch (err) {
            this._buffers = buffers;
            return this._buffers;
        }
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

    private async readDir(dirname: string): Promise<FileItem[]> {
        try {
            const entries = await fs.promises.readdir(dirname);
            const files = ['.', '..', ...entries];
            const result: Array<FileItem> = [];
            for (const filename of files) {
                const p = path.join(dirname, filename);
                try {
                    const stat = await fs.promises.stat(p);
                    const fi = FileItem.create(dirname, filename, stat);
                    if (fi) result.push(fi);
                } catch (err) {
                    // skip entries we can't stat
                }
            }
            return result.filter((fileItem) => {
                if (fileItem) {
                    if (this._show_dot_files) return true;
                    const filename = fileItem.fileName;
                    if (filename === '..' || filename === '.') return true;
                    return filename.substring(0, 1) !== '.';
                }
                return false;
            }) as FileItem[];
        } catch (err) {
            return [];
        }
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

    // Public helper to notify that a specific directory's listing changed.
    // This is used by external callers (commands) when they perform operations
    // that modify the filesystem but can't rely on `this.dirname` being set.
    public async notifyDirChanged(dir: string) {
        if (!dir) return;
        try {
            await this.createBuffer(dir);
            const uri = this.createPathUriForDir(dir);
            this._onDidChange.fire(uri);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            // also notify active dired uri (covers fixed_window mode)
            try {
                const activeUri = this.uri;
                if (activeUri && activeUri.toString() !== uri.toString()) {
                    this._onDidChange.fire(activeUri);
                    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: activeUri }]);
                }
            } catch (e) { /* ignore */ }
        } catch (e) {
            // ignore
        }
    }
}
