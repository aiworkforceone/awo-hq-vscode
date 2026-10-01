/**
 * A minimal typed event emitter with VS Code's `Event` shape (`event(listener) → Disposable`), so the
 * core services need no `vscode` import and the unit tier can drive them directly.
 */
export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => unknown;
export type Event<T> = (listener: Listener<T>) => Disposable;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch {
        /* one broken listener never stops the others */
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
