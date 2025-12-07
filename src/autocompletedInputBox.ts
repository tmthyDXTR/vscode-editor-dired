import * as vscode from 'vscode';

export function defaultFinishCondition(self: vscode.QuickPick<vscode.QuickPickItem>) {
    if (self.selectedItems.length == 0 || self.selectedItems[0].label == self.value) {
        return true;
    }
    else {
        self.value = self.selectedItems[0].label;
        return false;
    }
}

export async function autocompletedInputBox(
    arg: {
        // Completion may be synchronous or return a Promise resolving to an iterable
        completion: (userinput: string) => Iterable<vscode.QuickPickItem> | Promise<Iterable<vscode.QuickPickItem>>,
        withSelf?: ((self: vscode.QuickPick<vscode.QuickPickItem>) => void) | undefined,
        stopWhen?: ((self: vscode.QuickPick<vscode.QuickPickItem>) => boolean) | undefined
    }) {
    const completionFunc = arg.completion;
    const processSelf = arg.withSelf;

    let finishCondition = defaultFinishCondition;
    if (arg.stopWhen != undefined)
        finishCondition = defaultFinishCondition

    function isThenable(x: unknown): x is Promise<Iterable<vscode.QuickPickItem>> {
        const then = (x as { then?: unknown }).then;
        return typeof then === 'function';
    }


    const quickPick = vscode.window.createQuickPick();
    quickPick.canSelectMany = false;
    const disposables: vscode.Disposable[] = [];
    
    if (processSelf !== undefined)
        processSelf(quickPick);

    const makeTask = () => new Promise<void>(resolve => {
        disposables.push(
            quickPick.onDidChangeValue(() => {
                try {
                    const r = completionFunc(quickPick.value);
                    if (isThenable(r)) {
                        (r as Promise<Iterable<vscode.QuickPickItem>>).then(items => {
                            try { quickPick.items = Array.from(items); } catch (e) { /* ignore */ }
                        }).catch(() => { /* ignore */ });
                    } else {
                        quickPick.items = Array.from(r as Iterable<vscode.QuickPickItem>);
                    }
                } catch (e) {
                    // ignore errors from completion
                }
                return 0;
            }),
            quickPick.onDidAccept(() => {
                if (finishCondition(quickPick)) {
                    // value will be read from quickPick.value after the picker hides
                    quickPick.hide();
                    resolve();
                }
            }),
            quickPick.onDidHide(() => {
                quickPick.dispose();
                resolve();
            })
        );
        quickPick.show();
    });
    try {
        await makeTask();
    }
    finally {
        disposables.forEach(d => d.dispose());
    }
    return quickPick.value;
}
