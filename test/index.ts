//
// PLEASE DO NOT MODIFY / DELETE UNLESS YOU KNOW WHAT YOU ARE DOING
//
// This file is providing the test runner to use when running extension tests.
// By default the test runner in use is Mocha based.
//
// You can provide your own test runner if you want to override it by exporting
// a function run(testRoot: string, clb: (error:Error) => void) that the extension
// host can call to run the tests. The test runner is expected to use console.log
// to report the results back to the caller. When the tests are finished, return
// a possible error to the callback or null if none.

let testRunner: any = undefined;
try {
    // This module is provided by the VS Code extension host environment. If it
    // doesn't exist in some hosts, fall back to using the mocha runner directly.
    testRunner = require('vscode/lib/testrunner');
} catch (err) {
    testRunner = undefined;
}

// You can directly control Mocha options by uncommenting the following lines
// See https://github.com/mochajs/mocha/wiki/Using-mocha-programmatically#set-options for more info
if (testRunner) {
    testRunner.configure({
        ui: 'tdd',
        useColors: true // colored output from test results
    });
    module.exports = testRunner;
} else {
    // Fallback runner: set up mocha manually for environments that don't
    // expose the VS Code test runner. This is compatible with `runTests` which
    // will invoke our exported function to execute the tests.
    const Mocha = require('mocha');
    const fs = require('fs');
    const path = require('path');

    module.exports = {
        run: function (testsRoot: string, cb: (err?: Error) => void) {
        const mocha = new Mocha({ ui: 'tdd', color: true });
        const root = (testsRoot && fs.existsSync(testsRoot) && fs.statSync(testsRoot).isDirectory()) ? testsRoot : path.resolve(path.dirname(testsRoot || __dirname));
            try {
            const files = fs.readdirSync(root).filter((f: string) => f.endsWith('.test.js'));
            for (const f of files) mocha.addFile(path.join(root, f));
            mocha.run((failures: number) => {
                if (failures > 0) return cb(new Error(`${failures} tests failed`));
                return cb();
            });
            } catch (err) {
                cb(err as Error);
            }
        }
    };
}