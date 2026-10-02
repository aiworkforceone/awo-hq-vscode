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

export interface StubUri {
  scheme: string;
  authority: string;
  path: string;
  value: string;
  toString(): string;
}

export const Uri = {
  parse: (value: string): StubUri => {
    const m = /^([a-z]+):\/\/([^/]*)(.*)$/.exec(value);
    return {
      scheme: m?.[1] ?? '',
      authority: m?.[2] ?? '',
      path: m?.[3] ?? '',
      toString: () => value,
      value,
    };
  },
  from: (c: { scheme: string; authority?: string; path?: string }): StubUri => {
    const value = `${c.scheme}://${c.authority ?? ''}${c.path ?? ''}`;
    return {
      scheme: c.scheme,
      authority: c.authority ?? '',
      path: c.path ?? '',
      toString: () => value,
      value,
    };
  },
};

export class Disposable {
  constructor(private readonly fn: () => unknown) {}
  dispose(): void {
    this.fn();
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export enum FilePermission {
  Readonly = 1,
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
  static FileNotFound(u?: unknown): FileSystemError {
    return new FileSystemError(String(u ?? ''), 'FileNotFound');
  }
  static FileExists(u?: unknown): FileSystemError {
    return new FileSystemError(String(u ?? ''), 'FileExists');
  }
  static FileNotADirectory(u?: unknown): FileSystemError {
    return new FileSystemError(String(u ?? ''), 'FileNotADirectory');
  }
  static FileIsADirectory(u?: unknown): FileSystemError {
    return new FileSystemError(String(u ?? ''), 'FileIsADirectory');
  }
  static NoPermissions(m?: unknown): FileSystemError {
    return new FileSystemError(String(m ?? ''), 'NoPermissions');
  }
  static Unavailable(m?: unknown): FileSystemError {
    return new FileSystemError(String(m ?? ''), 'Unavailable');
  }
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

/** A QuickPick the test drives: `stub.quickPicks` holds every one shown. */
export class StubQuickPick<T extends { label: string }> {
  items: T[] = [];
  selectedItems: T[] = [];
  placeholder = '';
  title = '';
  shown = false;
  disposed = false;
  private readonly accept = new EventEmitter<void>();
  private readonly hide = new EventEmitter<void>();
  private readonly button = new EventEmitter<{ item: T; button: unknown }>();
  onDidAccept = this.accept.event;
  onDidHide = this.hide.event;
  onDidTriggerItemButton = this.button.event;
  show(): void {
    this.shown = true;
    stub.quickPicks.push(this as unknown as StubQuickPick<{ label: string }>);
    stub.onQuickPick?.(this as unknown as StubQuickPick<{ label: string }>);
  }
  dispose(): void {
    this.disposed = true;
  }
  /** The person picks the row whose label contains `text`. */
  pick(text: string): void {
    const item = this.items.find((i) => i.label.includes(text));
    if (!item) throw new Error(`no row "${text}" in ${this.items.map((i) => i.label).join(', ')}`);
    this.selectedItems = [item];
    this.accept.fire();
  }
  /** The person presses an item's button (sign out). */
  press(text: string): void {
    const item = this.items.find((i) => i.label.includes(text))!;
    this.button.fire({ item, button: {} });
  }
  escape(): void {
    this.hide.fire();
  }
}

export interface StubFolder {
  uri: StubUri;
  name: string;
  index: number;
}

export class TabInputText {
  constructor(readonly uri: StubUri) {}
}

/** Any other editor input (a custom editor, say): it has a uri but is not a text tab. */
export class TabInputCustom {
  constructor(
    readonly uri: StubUri,
    readonly viewType: string,
  ) {}
}

export interface StubTab {
  input: TabInputText | TabInputCustom | undefined;
  isDirty: boolean;
  isPreview: boolean;
  isActive: boolean;
  isPinned: boolean;
}

export interface StubTabGroup {
  viewColumn: number;
  isActive: boolean;
  tabs: StubTab[];
}

export interface StubTerminal {
  name: string;
  disposed: boolean;
  pty: { onDidChangeName?: (l: (n: string) => void) => unknown };
  /** Every `show(preserveFocus?)` call's argument. */
  shown: Array<boolean | undefined>;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

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
  progress: [] as Array<{ title: string; open: boolean; cancel: () => unknown }>,
  tabGroups: [] as StubTabGroup[],
  /** Open documents (`workspace.textDocuments`), by uri string. */
  textDocuments: [] as string[],
  closedTabs: [] as StubTab[],
  quickPicks: [] as Array<StubQuickPick<{ label: string }>>,
  onQuickPick: undefined as ((qp: StubQuickPick<{ label: string }>) => void) | undefined,
  /** `showQuickPick` answers with the item whose label contains this (undefined: Escape). */
  quickPickAnswer: undefined as string | undefined,
  quickPickOffered: [] as string[][],
  terminals: [] as StubTerminal[],
  commands: [] as Array<{ id: string; args: unknown[] }>,
  folders: [] as StubFolder[],
  workspaceFile: undefined as StubUri | undefined,
  folderChanged: new EventEmitter<void>(),
  messages: [] as Array<{ level: 'info' | 'warn' | 'error'; text: string }>,
  statusMessages: [] as string[],
  config: {} as Record<string, unknown>,
  /** The button the person "clicks" on the next notification that offers one. */
  choice: undefined as string | undefined,
  opened: [] as string[],
  /** Documents shown (`window.showTextDocument`), by uri string. */
  shownDocs: [] as string[],
  reset(): void {
    this.tabGroups = [];
    this.progress = [];
    this.textDocuments = [];
    this.closedTabs = [];
    this.quickPicks = [];
    this.onQuickPick = undefined;
    this.quickPickAnswer = undefined;
    this.quickPickOffered = [];
    this.terminals = [];
    this.commands = [];
    this.folders = [];
    this.workspaceFile = undefined;
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
  activeTerminal: undefined as StubTerminal | undefined,
  onDidCloseTerminal: () => ({ dispose: () => undefined }),
  onDidChangeActiveTerminal: () => ({ dispose: () => undefined }),
  onDidChangeWindowState: () => ({ dispose: () => undefined }),
  createQuickPick: <T extends { label: string }>() => new StubQuickPick<T>(),
  /** Progress notifications: each one shown, until its task settles (`open` false after). */
  withProgress: <R>(
    opts: { title?: string; cancellable?: boolean },
    task: (p: unknown, token: { onCancellationRequested(l: () => void): unknown }) => Thenable<R>,
  ): Thenable<R> => {
    const entry = { title: opts.title ?? '', open: true, cancel: () => undefined as unknown };
    stub.progress.push(entry);
    const listeners: Array<() => void> = [];
    entry.cancel = () => listeners.forEach((l) => l());
    const result = task({}, { onCancellationRequested: (l) => listeners.push(l) });
    void Promise.resolve(result).then(() => (entry.open = false));
    return result;
  },
  showQuickPick: async <T extends { label: string }>(items: T[] | Promise<T[]>) => {
    const list = await items;
    stub.quickPickOffered.push(list.map((i) => i.label));
    const want = stub.quickPickAnswer;
    return want === undefined ? undefined : list.find((i) => i.label.includes(want));
  },
  createTerminal: (opts: { name: string; pty: StubTerminal['pty'] }) => {
    const t: StubTerminal = {
      name: opts.name,
      disposed: false,
      pty: opts.pty,
      shown: [],
      show: (preserveFocus?: boolean) => void t.shown.push(preserveFocus),
      dispose: () => {
        t.disposed = true;
      },
    };
    (opts.pty as { onDidChangeName?: (l: (n: string) => void) => unknown }).onDidChangeName?.(
      (n: string) => {
        t.name = n;
      },
    );
    stub.terminals.push(t);
    // VS Code opens the pseudoterminal once the tab exists.
    setTimeout(
      () => (opts.pty as { open?: (d: unknown) => void }).open?.({ columns: 80, rows: 24 }),
      0,
    );
    return t;
  },
  /** Editor tabs (`stub.tabGroups` holds them; `close` removes and records). */
  tabGroups: {
    get all() {
      return stub.tabGroups;
    },
    close: async (tab: StubTab) => {
      stub.closedTabs.push(tab);
      for (const g of stub.tabGroups) g.tabs = g.tabs.filter((t) => t !== tab);
      return true;
    },
  },
  createStatusBarItem: () => ({
    text: '',
    name: '',
    tooltip: '',
    command: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
};

export const commands = {
  executeCommand: async (id: string, ...args: unknown[]) => {
    stub.commands.push({ id, args });
    return undefined;
  },
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T =>
      (stub.config[`${section}.${key}`] as T | undefined) ?? (fallback as T),
  }),
  get textDocuments(): Array<{ uri: StubUri }> {
    return stub.textDocuments.map((u) => ({ uri: Uri.parse(u) }));
  },
  get workspaceFolders(): StubFolder[] {
    return stub.folders;
  },
  get workspaceFile(): StubUri | undefined {
    return stub.workspaceFile;
  },
  onDidChangeWorkspaceFolders: (l: () => unknown) => stub.folderChanged.event(l),
  updateWorkspaceFolders: (
    start: number,
    deleteCount: number,
    ...add: Array<{ uri: StubUri; name?: string }>
  ): boolean => {
    const next = [...stub.folders];
    next.splice(
      start,
      deleteCount,
      ...add.map((a) => ({ uri: a.uri, name: a.name ?? a.uri.toString(), index: 0 })),
    );
    stub.folders = next.map((f, index) => ({ ...f, index }));
    setTimeout(() => stub.folderChanged.fire(), 0);
    return true;
  },
};

export const env = {
  appName: 'Visual Studio Code',
  openExternal: async (uri: { toString(): string }) => {
    stub.opened.push(uri.toString());
    return true;
  },
  clipboard: { writeText: async () => undefined },
};
