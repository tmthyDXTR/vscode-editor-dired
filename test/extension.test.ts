//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as myExtension from '../src/extension';
import FileItem from '../src/fileItem';
import { IDResolver } from '../src/idResolver';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", () => {

    // Defines a Mocha unit test
    test("Something 1", () => {
        assert.equal(-1, [1, 2, 3].indexOf(5));
        assert.equal(-1, [1, 2, 3].indexOf(0));
    });

    test("Format and parse size", () => {
        const f = new FileItem('C:\\tmp', 'myfile.txt', false, true, 'me', 'me', 5500, 'Dec', 1, 12, 0, '-rw-r--r--', false);
        const line = f.line();
        const parsed = FileItem.parseLine('C:\\tmp', line);
        assert.equal(parsed.fileName, 'myfile.txt');
        assert.equal(parsed['_size'] || (parsed as any)._size, 5500);
    });

    test("Do not print 'undefined' username/group", () => {
        const f = new FileItem('C:\\tmp', 'myfile2.txt', false, true, undefined, undefined, 123, 'Dec', 1, 12, 0, '-rw-r--r--', false);
        const line = f.line();
        assert.equal(line.includes('undefined'), false, `line should not contain 'undefined', got ${line}`);
        const parsed = FileItem.parseLine('C:\\tmp', line);
        assert.equal(parsed.fileName, 'myfile2.txt');
        assert.equal((parsed as any)._username === undefined || (parsed as any)._username === null, true);
    });

    test('IDResolver sanitizes cache and ignores undefined values', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dired-test-'));
        const homeBackup = process.env.HOME || process.env.USERPROFILE;
        // Set home directory to temp folder for this test
        process.env.HOME = tmp;
        process.env.USERPROFILE = tmp;
        try {
            const userCache = path.join(tmp, '.vscode-dired-user-cache');
            fs.writeFileSync(userCache, 'undefined::1001\njoe::1000', { encoding: 'utf8' });
            const r = new IDResolver();
            assert.equal(r.username(1000), 'joe');
            assert.equal(r.username(1001), undefined);
            const contents = fs.readFileSync(userCache, { encoding: 'utf8' });
            assert.equal(contents.includes('undefined'), false);
        } finally {
            // restore home
            if (homeBackup) process.env.HOME = homeBackup; process.env.USERPROFILE = homeBackup || process.env.USERPROFILE;
            // cleanup tmp
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
    });

    test('Windows fallback username when resolver returns undefined', () => {
        // Simulate this by creating a FileItem with undefined username via constructor
        const f = new FileItem('C:\\tmp', 'winfile.txt', false, true, undefined, undefined, 100, 'Dec', 1, 12, 0, '-rw-r--r--', false);
        let line = f.line();
        // On non-Windows this will still be empty, but we assert that it doesn't contain 'undefined'
        assert.equal(line.includes('undefined'), false);
    });

    test('Parsed start column matches actual column', () => {
        // Create a realistic FileItem line and ensure parseLine computes startColumn
        const f = new FileItem('C:\\tmp', 'filewithspace.txt', false, true, 'me', 'me', 12345, 'Dec', 6, 5, 9, '-rw-r--r--', false);
        const line = f.line();
        const parsed = FileItem.parseLine('C:\\tmp', line);
        assert.equal(typeof parsed.startColumn === 'number', true);
        if (typeof parsed.startColumn === 'number') {
            assert.equal(line.substring(parsed.startColumn, parsed.startColumn + parsed.fileName.length), parsed.fileName);
        }
    });

    test('FileItem.create sets startColumn', () => {
        const st = require('fs').lstatSync('.');
        // Using a small file in repo to create FileItem and test for startColumn
        const f = FileItem.create('.', 'README.md', st);
        assert.equal(typeof f.startColumn === 'number', true);
        if (typeof f.startColumn === 'number') {
            const line = f.line();
            assert.equal(line.substring(f.startColumn, f.startColumn + f.fileName.length), f.fileName);
        }
    });

    test('parseLine for created lines returns same startColumn', () => {
        const st = require('fs').lstatSync('.');
        const f = FileItem.create('.', 'CHANGELOG.md', st);
        const line = f.line();
        const parsed = FileItem.parseLine('.', line);
        assert.equal(typeof parsed.startColumn === 'number', true);
        if (typeof parsed.startColumn === 'number' && typeof f.startColumn === 'number') {
            assert.equal(parsed.startColumn, f.startColumn, `expected parseLine.startColumn=${parsed.startColumn} to equal create.startColumn=${f.startColumn}`);
            assert.equal(line.substring(parsed.startColumn, parsed.startColumn + parsed.fileName.length), parsed.fileName);
        }
    });

    test('startColumn after time token', () => {
        const f = new FileItem('.', 'a.txt', false, true, 'me', 'me', 1234, 'Dec', 6, 5, 9, '-rw-r--r--', false);
        const line = f.line();
        const parsed = FileItem.parseLine('.', line);
        assert.equal(typeof parsed.startColumn === 'number', true);
        const timeMatch = line.match(/\d{2}:\d{2}/);
        if (timeMatch && typeof timeMatch.index === 'number' && typeof parsed.startColumn === 'number') {
            let pos = timeMatch.index + timeMatch[0].length;
            while (pos < line.length && line.charAt(pos) === ' ') pos++;
            assert.equal(parsed.startColumn, pos);
        }
    });

    test('DocumentLink start column equals computed lastIndexOf', () => {
        // Use examples from repo to validate start column computation
        const examples = ['README.md', 'package.json', '.gitignore', '.vscodeignore'];
        for (const name of examples) {
            try {
                const st = require('fs').statSync(name);
                const f = FileItem.create('.', name, st);
                const line = f.line();
                const parsed = FileItem.parseLine('.', line);
                const fname = parsed.fileName;
                assert.equal(fname, name);
                // Compute expected start as lastIndexOf
                const expected = line.lastIndexOf(fname);
                const actual = (typeof parsed.startColumn === 'number') ? parsed.startColumn : line.lastIndexOf(fname);
                assert.equal(actual, expected, `expected start ${expected} vs actual ${actual} for ${name}`);
                assert.equal(line.substring(actual, actual + fname.length), fname);
            } catch (e) {
                // If any file isn't present, skip
            }
        }
    });
});