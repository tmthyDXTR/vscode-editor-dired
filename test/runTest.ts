import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // The compiled tests live under `out/test`, so step up two directories to
        // the project root where the `package.json` for the extension lives.
        const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
        const extensionTestsPath = path.resolve(__dirname, './index.js');
        // If running on a dev machine with VSCode installed, prefer using the local
        // executable path to avoid repeated downloads and potential unzip errors.
        let vscodeExecutablePath: string | undefined = undefined;
        const localCandidate = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined;
        if (localCandidate && fs.existsSync(localCandidate)) {
            vscodeExecutablePath = localCandidate;
        }
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            vscodeExecutablePath,
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}

main();
