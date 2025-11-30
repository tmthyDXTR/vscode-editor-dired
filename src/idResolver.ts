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
        return this._user_cache.get(uid);
    }
    groupname(uid: number): string | undefined {
        return this._group_cache.get(uid);
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
            for (const line of lines) {
                if (!line) continue;
                const l = line.split(':');
                // Expect format: name:...:id
                const name = l[0];
                const idStr = l.length > 2 ? l[2] : l[1];
                const uid = parseInt(idStr || '', 10);
                if (Number.isNaN(uid)) continue;
                if (user) {
                    this._user_cache.set(uid, name);
                } else {
                    this._group_cache.set(uid, name);
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