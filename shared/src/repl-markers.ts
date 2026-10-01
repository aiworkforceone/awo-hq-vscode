/**
 * The Claude Code TUI markers shared by every consumer that reads a rendered Claude screen: the
 * scheduler's readiness classifier (`src/scheduler/repl-state.ts`, which imports them from here), the
 * browser terminal's local-echo prompt gate and the `hq attach` CLI's (feature `local-echo`,
 * Decisions 4 and 12). Extracted verbatim so the three read ONE set of ground-truthed patterns; a
 * copy per consumer is how they drift.
 *
 * Pure data: no Node, no DOM, nothing else from the classifier. Every pattern runs on ANSI-stripped
 * text with `\s*` between words (claude renders prose spaceless; see repl-state.ts's header).
 */

/**
 * The main REPL footer — renders ONLY on the interactive prompt screen (never inside dialogs; same
 * ground truth as the client's `looksLikeMainPromptFooter`). Deliberately restricted to footer text:
 * the old `AGENT_READY` band-aid also accepted a bare `❯`, but claude uses `❯` as the SELECTOR in
 * every menu (trust prompt, theme picker, /login method menu), so it reported "ready" while a modal
 * dialog was eating keystrokes — one of the ways injections kept silently dying.
 *
 * `? for shortcuts` is only the DEFAULT-permission-mode footer. In the other permission modes claude
 * replaces it with the mode banner in the same footer slot — `bypass permissions on (shift+tab to
 * cycle)` / `accept edits on` / `plan mode on` — and renders `? for shortcuts` NOT AT ALL. Every
 * platform "Autopilot" session runs bypassPermissions, so with only the `?for shortcuts` marker a
 * CLEANLY idle Autopilot session classified 'unknown' forever and every scheduled injection into it
 * died `agent_not_ready` (prod 2026-08-19, tcb `campaigns - en - acdi` 09:00 run; its PT twin passed
 * the same morning only because a stale `esc to interrupt` from earlier work still sat inside the
 * 16 KB scan window). All four footer variants render exclusively on the main prompt screen, so they
 * are equally safe "at the prompt" markers; matched spaceless/`\s*` like everything else here, and
 * ground-truthed against the live prod session buffers (both tails match `bypasspermissionson`).
 *
 * DEF-173 — claude-code 2.1.282 adds a FIFTH banner in the same slot: `⏵⏵ auto mode on (shift+tab to
 * cycle)`. The product never launches auto mode, but shift+tab cycles into it, and an idle session
 * there rendered none of the four markers above — `unknown`, the same 2026-08-19 failure. Found by
 * the Claude Code contract suite driving the real 2.1.282 binary. Its match ends at a non-letter
 * (`(?![a-z])`): "auto mode only" is ordinary prose in a way "bypass permissions on" is not.
 *
 * session-chat-view (train 34, nonprod) — 2.1.282's DEFAULT mode footer is `⏸ manual mode on · ? for
 * shortcuts`, and once the box holds text it drops the hint and shows `⏸ manual mode on` alone. The
 * typed box then matched nothing, read `unknown`, and Chat's check before the Enter took it for an
 * open prompt: the text was typed and the Enter withheld. Every prompt Claude draws REPLACES this
 * footer (captured: Bash, Write, AskUserQuestion, ExitPlanMode), so it is as safe a marker as the
 * other mode banners; same `(?![a-z])` ending ("manual mode only").
 */
export const MAIN_PROMPT_FOOTER =
  /\?\s*for\s*shortcuts|bypass\s*permissions\s*on|accept\s*edits\s*on|plan\s*mode\s*on|auto\s*mode\s*on(?![a-z])|manual\s*mode\s*on(?![a-z])/i;

/**
 * A WORKING agent (`✻ Thinking… (esc to interrupt)`). The input box still accepts typed text and
 * queues the submit, so for injection purposes this counts as interactive — and its appearance
 * right after an Enter is the strongest "the prompt was accepted" signal there is.
 */
export const ESC_TO_INTERRUPT = /esc\s*to\s*interrupt/i;

/**
 * A first-run/startup MODAL that claude renders as a full-screen takeover — no input box, no prompt
 * footer, and it eats keystrokes until it is answered. `dialog` is a strict REFINEMENT of `unknown`:
 * it is only ever reached when nothing else on the screen matched, so a session sitting at its prompt
 * TALKING about one of these dialogs still classifies `ready` and still gets its prompt.
 *
 * Why it earns its own state (DEF-82, nonprod 2026-09-17): the fire that meets one of these dies
 * `agent_not_ready_after_restart` — a name that sends every reader hunting a wedged TUI, when the
 * truth is "a modal is up and nobody has answered it". The state exists to make the run row say the
 * second thing. It does NOT change what the injector DOES: a `dialog` takes the same single
 * escalation restart as an `unknown`, because that restart genuinely cures it (the login dir is
 * re-seeded on every spawn, so the fresh boot comes up past the modal). Only a modal still standing
 * AFTER the restart reports `agent_dialog_open`.
 *
 * NOTE the injector NEVER auto-answers one of these (its standing rule: never send Escape, which
 * interrupts a working agent). The durable fix is the pre-seed in
 * `src/providers/claude-onboarding.ts`, which stops both dialogs below from rendering at all.
 */
export interface KnownDialog {
  /** Stable id for logs/metrics (never a byte of screen content). */
  id: string;
  /** The dialog's first line, VERBATIM from claude's own source — safe to log, carries no session data. */
  firstLine: string;
  /** Spaceless/ANSI-tolerant matcher for that first line (claude renders prose without spaces). */
  pattern: RegExp;
  /**
   * The dialog's OWN answer affordance — its confirm/cancel labels, verbatim from the same source.
   * On the raw-tail path the title alone is not enough (see `tailDialog`): the choice row must be
   * present AFTER it, which is the difference between "this modal is on screen" and "these words
   * appeared in the scrollback".
   */
  choice: RegExp;
}

/**
 * The startup-chain modals of Claude Code v2.1.270 — the version `docker/Dockerfile` pins and the
 * one CI actually builds with (the workflow passes only `APP_VERSION`, so the `ARG` default stands).
 * Read out of the shipped bundle; see `src/providers/claude-onboarding.ts` for the byte offsets and
 * the quoted source lines, which is also where the durable fix lives.
 *
 * The chain (`class foe`'s startup task) raises three dialogs back to back. Only TWO are listed:
 *   1. the fullscreen-renderer upsell — the one that caused DEF-82;
 *   2. the auto-mode default nudge;
 *   3. an effort-level nudge whose body copy is SERVED REMOTELY. It has no stable first line and no
 *      stable choice labels, so there is nothing sound to match on — it is handled by the onboarding
 *      seed alone and is deliberately absent here. A table entry guessing at its copy would be worse
 *      than no entry: it would make `dialog` a coin-flip on text we do not control.
 *
 * `Trust this directory?` was in an earlier revision of this table and was REMOVED on review. That
 * title belongs to the Remote Control add-server flow, not to the workspace trust prompt the
 * onboarding seed pre-accepts — a plausible-looking entry for a dialog these sessions never meet.
 */
export const KNOWN_DIALOGS: readonly KnownDialog[] = [
  {
    id: 'fullscreen_renderer',
    firstLine: 'Try the new fullscreen renderer?',
    pattern: /try\s*the\s*new\s*fullscreen\s*renderer/i,
    // confirmLabel:"Yes, try it", cancelLabel:"Not now"
    choice: /yes,?\s*try\s*it|not\s*now/i,
  },
  {
    id: 'auto_mode_default',
    firstLine: 'Make auto mode your default permission mode?',
    pattern: /make\s*auto\s*mode\s*your\s*default\s*permission\s*mode/i,
    // "Yes, set auto mode as my default permission mode" / "No, keep …"
    choice: /yes,?\s*set\s*auto\s*mode|no,?\s*keep/i,
  },
  // DEF-174 — NOT a startup-chain modal: the one-time approval Claude Code raises when
  // ANTHROPIC_API_KEY is set and not yet approved — every `team_api_key` session's first start
  // (`session-env.ts`). Copy verbatim from the 2.1.282 bundle and its live render: title
  // "Detected a custom API key in your environment", options "Yes" / "No (recommended)". The
  // choice matcher is the `No (recommended)` row only: a bare "Yes" is far too common to anchor on.
  // The durable fix is the onboarding seed (`customApiKeyResponses.approved`); this entry makes a
  // session that still meets it say so instead of reading `unknown`.
  {
    id: 'custom_api_key',
    firstLine: 'Detected a custom API key in your environment',
    pattern: /detected\s*a\s*custom\s*api\s*key\s*in\s*your\s*environment/i,
    choice: /no\s*\(\s*recommended\s*\)/i,
  },
];

/**
 * How many trailing non-blank rows of a rendered screen count as the FOOTER REGION. claude's mode
 * footer / `? for shortcuts` line sits in the last couple of rows under the input box; bounding the
 * ready marker to that region is what makes the screen model stricter than the byte tail (a footer
 * phrase quoted inside the transcript can no longer read as "at the prompt").
 */
export const SCREEN_FOOTER_ROWS = 8;
