import * as vscode from 'vscode';
import * as path from 'path';
import FileItem from './fileItem';

export function showMarkedInActiveBuffer(markedPaths?: string[]) {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !ed.document || ed.document.uri.scheme !== 'dired') {
        vscode.window.showInformationMessage('Open a Dired buffer to show marked files.');
        return;
    }

    // Derive directory from header line (same logic as provider.dirname)
    let header = ed.document.lineAt(0).text || '';
    header = header.replace(/:\s*$/, '');
    header = header.replace(/^Dired:\s*/, '').trim();
    const dir = header || '.';

    const marked: string[] = [];
    if (Array.isArray(markedPaths)) {
        // Use provided canonical marked paths if available
        for (const p of markedPaths) {
            try { marked.push(path.resolve(p)); } catch (e) { /* ignore */ }
        }
    } else {
        // Fallback: parse the document lines for the '*' marker
        for (let i = 1; i < ed.document.lineCount; i++) {
            const line = ed.document.lineAt(i).text;
            if (!line || !line.trim()) continue;
            try {
                const item = FileItem.parseLine(dir, line);
                if (!item || !item.fileName) continue;
                const rendered = item.line();
                if (rendered && rendered.charAt(0) === '*') {
                    // skip '.' and '..'
                    if (item.fileName === '.' || item.fileName === '..') continue;
                    marked.push(path.resolve(dir, item.fileName));
                }
            } catch (e) { /* ignore parse errors */ }
        }
    }

    const channel = vscode.window.createOutputChannel('Dired Selections');
    channel.clear();
    channel.appendLine(`Marked files (${marked.length}):`);
    for (const m of marked) channel.appendLine(m);
    channel.show(true);
    vscode.window.setStatusBarMessage(`Dired: ${marked.length} marked`, 2000);
}

export default { showMarkedInActiveBuffer };
