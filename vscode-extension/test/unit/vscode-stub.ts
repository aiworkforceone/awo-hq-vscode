/**
 * A test double of the small part of the `vscode` API the extension's units use. Everything the
 * code shows a person is RECORDED on `stub` so a test can assert it; nothing here is a real editor.
 * The real API is exercised by the `@vscode/test-electron` suite (test/suite).
 */

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: ThemeIcon;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export const Uri = {
  parse: (value: string) => ({ toString: () => value, value }),
  from: (c: { scheme: string; authority?: string; path?: string }) => {
    const value = `${c.scheme}://${c.authority ?? ''}${c.path ?? ''}`;
    return { ...c, toString: () => value, value };
  },
};

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

export class FileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
}

/** What the code under test showed. Reset it in `beforeEach`. */
export const stub = {
  messages: [] as Array<{ level: 'info' | 'warn' | 'error'; text: string }>,
  statusMessages: [] as string[],
  config: {} as Record<string, unknown>,
  /** The button the person "clicks" on the next notification that offers one. */
  choice: undefined as string | undefined,
  opened: [] as string[],
  /** Documents shown (`window.showTextDocument`), by uri string. */
  shownDocs: [] as string[],
  reset(): void {
    this.shownDocs = [];
    this.messages = [];
    this.statusMessages = [];
    this.config = {};
    this.choice = undefined;
    this.opened = [];
  },
};

export const window = {
  showInformationMessage: async (text: string) => {
    stub.messages.push({ level: 'info', text });
    return undefined;
  },
  showWarningMessage: async (text: string, ...items: string[]) => {
    stub.messages.push({ level: 'warn', text });
    return stub.choice !== undefined && items.includes(stub.choice) ? stub.choice : undefined;
  },
  showErrorMessage: async (text: string) => {
    stub.messages.push({ level: 'error', text });
    return undefined;
  },
  showTextDocument: async (uri: { toString(): string }) => {
    stub.shownDocs.push(uri.toString());
    return undefined;
  },
  setStatusBarMessage: (text: string) => {
    stub.statusMessages.push(text);
    return { dispose: () => undefined };
  },
  state: { focused: true },
  activeTerminal: undefined,
  onDidCloseTerminal: () => ({ dispose: () => undefined }),
  onDidChangeActiveTerminal: () => ({ dispose: () => undefined }),
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T =>
      (stub.config[`${section}.${key}`] as T | undefined) ?? (fallback as T),
  }),
};

export const env = {
  appName: 'Visual Studio Code',
  openExternal: async (uri: { toString(): string }) => {
    stub.opened.push(uri.toString());
    return true;
  },
  clipboard: { writeText: async () => undefined },
};
