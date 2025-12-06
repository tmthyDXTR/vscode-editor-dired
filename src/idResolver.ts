'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path'

export class IDResolver {
    private _user_cache = new Map<number, string>();
    private _group_cache = new Map<number, string>();

    constructor() {
        // Load both caches synchronously at startup; these files are expected to be small.
        this.create(true);
        this.create(false);
    }

    username(uid: number): string | undefined {
        const v = this._user_cache.get(uid);
        if (!v) return undefined;
        if (v.toLowerCase() === 'undefined' || v.toLowerCase() === 'null') return undefined;
        return v;
    }
    groupname(uid: number): string | undefined {
        const v = this._group_cache.get(uid);
        if (!v) return undefined;
        if (v.toLowerCase() === 'undefined' || v.toLowerCase() === 'null') return undefined;
        return v;
    }

    private create(user: boolean) {
        // create a cache file in the user's home directory for Windows and Unix
        const home = require('os').homedir();
        const cache_file = user ? '.vscode-dired-user-cache' : '.vscode-dired-group-cache';
        const cache_path = path.join(home, cache_file);

        try {
            if (!fs.existsSync(cache_path)) {
                // create empty file
                fs.writeFileSync(cache_path, '');
            }
            // Read whole file synchronously (small) and parse lines. Simpler and
            // avoids creating extra stream/listener objects that would be retained.
            const data = fs.readFileSync(cache_path, { encoding: 'utf8' });
            if (!data) return;
            const lines = data.split(/\r?\n/);
            const sanitizedEntries: Array<{ name: string, id: number }> = [];
            for (const line of lines) {
                if (!line) continue;
                const l = line.split(':');
                // Expect format: name:...:id
                const rawName = l[0];
                const name = (rawName ? rawName.trim() : undefined);
                const idStr = l.length > 2 ? l[2] : l[1];
                const uid = parseInt(idStr || '', 10);
                if (Number.isNaN(uid)) continue;
                const invalid = (n: string | undefined) => !n || n.toLowerCase() === 'undefined' || n.toLowerCase() === 'null';
                if (user) {
                    if (!invalid(name)) { this._user_cache.set(uid, name as string); sanitizedEntries.push({ name: name as string, id: uid }); }
                } else {
                    if (!invalid(name)) { this._group_cache.set(uid, name as string); sanitizedEntries.push({ name: name as string, id: uid }); }
                }
            }
            // if sanitizedEntries count differs from total lines, rewrite cache file to a sanitized subset
            if (sanitizedEntries.length !== lines.length) {
                try {
                    const out = sanitizedEntries.map(x => `${x.name}::${x.id}`).join('\n');
                    fs.writeFileSync(cache_path, out, { encoding: 'utf8' });
                } catch (e) {
                    // ignore write errors
                }
            }
        } catch (e) {
            // swallow errors; resolver caches are best-effort
        }
    }

    createOnMac() {
        // dscl . -list /Users UniqueID
        // dscl . -list /Groups gid
    }
}