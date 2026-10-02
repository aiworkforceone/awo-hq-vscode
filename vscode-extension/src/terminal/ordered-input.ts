/**
 * The terminal's input, in order, around an asynchronous rewrite (hq-vscode-image-paste): a dropped
 * image path is uploaded before its replacement goes out, and every key typed meanwhile waits behind
 * it, so nothing reaches the session out of order. Input with nothing to rewrite (every key typed)
 * goes straight out while nothing is waiting.
 */
export class OrderedInput {
  private tail: Promise<void> | null = null;
  private pending = 0;

  /**
   * `rewrite`: null (synchronously) when the chunk is not a candidate; otherwise a promise of the
   * text to send instead (null: send nothing).
   */
  constructor(
    private readonly send: (data: string) => void,
    private readonly rewrite: (chunk: string) => Promise<string | null> | null,
  ) {}

  push(data: string): void {
    const rewritten = this.rewrite(data);
    if (rewritten === null && this.tail === null) {
      this.send(data);
      return;
    }
    this.pending += 1;
    const step = async (): Promise<void> => {
      let out: string | null = data;
      if (rewritten !== null) {
        try {
          out = await rewritten;
        } catch {
          out = data; // the rewrite failed: what was typed goes out as it was
        }
      }
      if (out === null || out.length === 0) return;
      try {
        this.send(out);
      } catch {
        /* a send that throws (the socket went) must never leave the chain rejected */
      }
    };
    this.tail = (this.tail ?? Promise.resolve()).then(step).finally(() => {
      this.pending -= 1;
      if (this.pending === 0) this.tail = null;
    });
  }
}
