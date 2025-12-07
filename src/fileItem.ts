
'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const Mode = require('stat-mode');
import DiredProvider from './provider';
import { IDResolver } from './idResolver';
import { pathToFileURL } from 'url';


export default class FileItem {

    constructor(
        private _dirname: string,
        private _filename: string,
        private _isDirectory: boolean = false,
        private _isFile: boolean = true,
        private _username: string | undefined = undefined,
        private _groupname: string | undefined = undefined,
        private _size: number = 0,
        // Allow string months (3-letter) or numbers for backward compatibility
        private _month: string | number = 0,
        private _day: number = 0,
        private _hour: number = 0,
        private _min: number = 0,
        private _modeStr: string | undefined = undefined,
        private _selected: boolean = false,
        private _startColumn: number | undefined = undefined) {}

    static _resolver = new IDResolver();

    public static create(dir: string, filename: string, stats: fs.Stats) {
        const mode = new Mode(stats);
        const os = require('os');
            let username = FileItem._resolver.username(stats.uid) || undefined;
            const groupname = FileItem._resolver.groupname(stats.gid) || undefined;
            // On Windows, stats.uid/gid may be unavailable; fall back to the current
            // user's name (so the listing is not empty).
            if ((!username || username.trim().length === 0) && process.platform === 'win32') {
                try { username = os.userInfo().username; } catch (e) { /* ignore */ }
            }
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const f = new FileItem(
            dir,
            filename,
            mode.isDirectory(),
            mode.isFile(),
            username,
            groupname,
            stats.size,
            MONTHS[stats.ctime.getMonth()],
            stats.ctime.getDate(),
            stats.ctime.getHours(),
            stats.ctime.getMinutes(),
            mode.toString(),
            false);
        // compute start column for filename in the formatted line
        try {
            const line = f.line();
            const idx = line.lastIndexOf(filename);
            if (idx >= 0) f._startColumn = idx;
        } catch (e) { /* ignore */ }
        return f;
    }

    select(value : boolean) {
        this._selected = value;
    }

    get path(): string {
        return path.join(this._dirname, this._filename);
    }
    get fileName(): string {
        return this._filename;
    }

    public line(): string {
        // Use '-' as a placeholder so `parseLine` regex which expects non-space tokens
        // can still match username/group fields when values are absent. This also
        // ensures column positions are consistent when username/group are missing.
        const u = this._username && this._username.length ? this._username : '-';
        const g = this._groupname && this._groupname.length ? this._groupname : '-';
        const fsize = this.formatSize(this._size);
        const size = this.padStr(fsize, 8, " ");
        const month = (typeof this._month === 'number') ? this.pad(this._month, 2, "0") : ((this._month + "   ").substring(0, 3));
        const day = this.pad(this._day, 2, "0");
        const hour = this.pad(this._hour, 2, "0");
        const min = this.pad(this._min, 2, "0");
        let se = " ";
        if (this._selected) {
            se = "*";
        }
        const prefix = `${se} ${this._modeStr} ${u} ${g} ${size} ${month} ${day} ${hour}:${min} `;
        // Store start column of filename in the item so callers can accurately
        // compute link ranges and cursor positions without re-scanning the line.
        try { this._startColumn = prefix.length; } catch (e) { /* ignore */ }
        return `${prefix}${this._filename}`;
    }

    // Format file sizes in a human-friendly binary/decimal form.
    // e.g., 532 -> "532", 5500 -> "5.5K", 1234567 -> "1.2M"
    public formatSize(bytes: number): string {
        if (bytes === undefined || bytes === null) return ''; 
        if (bytes < 1000) return String(bytes);
        const units = ['K', 'M', 'G', 'T', 'P'];
        let value = bytes;
        let unitIndex = -1;
        while (value >= 1000 && unitIndex < units.length - 1) {
            value = value / 1000;
            unitIndex++;
        }
        // Format with one decimal if <10, otherwise no decimals
        const formatted = (value < 10 && Math.round(value * 10) / 10 !== Math.round(value)) ? value.toFixed(1) : Math.round(value).toString();
        return `${formatted}${units[unitIndex]}`;
    }

    // Pad a string to a required width
    public padStr(s: string, size: number, p: string): string {
        let str = s + "";
        while (str.length < size) str = p + str;
        return str;
    }

    public static parseLine(dir: string, line: string): FileItem {
        // Robust regex to parse our formatted line. This supports 3-letter months
        // and a numeric month token as fallback.
        const re = /^\s*(\*?)\s+([\-d][rwx\-]{9})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+):(\d+)\s+(.+)$/;
        const exec = re.exec(line);
        const m = exec;
        if (!m) {
            // fallback: get filename and return empty/zero file item
            // Attempt robust fallback: look for HH:MM token (colon) then filename afterwards
            const colonIdx = line.lastIndexOf(':');
            let filename = '';
            if (colonIdx >= 0) {
                // find first nonspace after colon
                let pos = colonIdx + 1;
                while (pos < line.length && line.charAt(pos) === ' ') pos++;
                filename = line.substring(pos).trim();
            } else {
                // fallback last token
                const parts = line.trim().split(/\s+/);
                filename = parts.length ? parts[parts.length - 1] : '';
            }
            return new FileItem(dir, filename, false, true, undefined, undefined, 0, 0, 0, 0, 0, '', false);
        }
        const isSelected = m[1] === '*';
        const modeStr = m[2];
        const normalize = (s: string | undefined) => {
            if (!s) return undefined;
            const t = s.trim().toLowerCase();
            if (t === 'undefined' || t === 'null' || t === '-') return undefined;
            return s;
        }
        const username = normalize(m[3]);
        const groupname = normalize(m[4]);
        const size = FileItem.parseSizeString(m[5] || '0');
        const monthToken = m[6];
        const day = parseInt(m[7] || '0', 10);
        const hour = parseInt(m[8] || '0', 10);
        const min = parseInt(m[9] || '0', 10);
        const filename = m[10];
        const isDirectory = (modeStr.substring(0, 1) === 'd');
        const isFile = (modeStr.substring(0, 1) === '-');
        // Compute start column from the original matched substring where possible
        let startCol: number | undefined = undefined;
        try {
            const matchIndex = (exec && typeof exec.index === 'number') ? exec.index : undefined;
            if (typeof matchIndex === 'number') {
                const matchedStr = m[0];
                const rel = matchedStr.lastIndexOf(filename);
                if (rel >= 0) startCol = matchIndex + rel;
            }
        } catch (e) { /* ignore */ }
        if (startCol === undefined) {
            // Fallback: build a FileItem and compute its `line()` and pick lastIndexOf there.
            try {
                const fallback = new FileItem(dir, filename, isDirectory, isFile, username, groupname, size, monthToken, day, hour, min, modeStr, isSelected, undefined);
                const sline = fallback.line();
                const idx = sline.lastIndexOf(filename);
                if (idx >= 0) startCol = idx;
            } catch (e) { /* ignore */ }
        }
        return new FileItem(dir, filename, isDirectory, isFile, username, groupname, size, monthToken, day, hour, min, modeStr, isSelected, startCol);
    }

    private static parseSizeString(s: string): number {
        if (!s) return 0;
        s = s.trim();
        const units: { [k: string]: number } = { 'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15 };
        const last = s.substring(s.length - 1).toUpperCase();
        if (units[last]) {
            const num = parseFloat(s.substring(0, s.length - 1));
            if (isNaN(num)) return 0;
            return Math.round(num * units[last]);
        }
        const n = parseInt(s, 10);
        return isNaN(n) ? 0 : n;
    }

    public get uri(): vscode.Uri | undefined {
        const p = path.join(this._dirname, this._filename);
        if (this._isDirectory) {
            // Convert the file path into a dired: scheme uri while keeping path information.
            return vscode.Uri.file(p).with({ scheme: DiredProvider.scheme });
        } else if (this._isFile) {
            const u = pathToFileURL(p);
            return vscode.Uri.parse(u.href);
        }
        return undefined;
    }

    public get startColumn(): number | undefined {
        return this._startColumn;
    }

    pad(num:number, size:number, p: string): string {
        let s = num+"";
        while (s.length < size) s = p + s;
        return s;
    }
}
 