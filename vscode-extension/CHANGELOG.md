# Changelog

## 0.4.1

- When your access changes so you can no longer watch a session, its terminal says "Your access to
  this session ended." instead of "Session not found".

## 0.4.0

- A session HQ is still starting shows `starting` in the Teams view instead of looking like a
  running one, and Start on it says "Session "fix login bug" is already starting." instead of
  "already running". With an older HQ, sessions show as before.
- Start, Stop and Restart on each session in the Teams view, as icons and in the right-click menu,
  shown only on sessions you may operate (the session owner or a team owner, as in HQ). Stop and
  Restart ask first while Claude or Codex is answering. A refusal, such as a team at its session
  limit, shows as a notification. Too many starts in a minute says how long to wait ("Too many
  requests. Try again in 34 seconds.").
- A start, stop, restart or port forward that reached the server without this computer's signature
  now says so, instead of nothing (Start, Stop, Restart) or asking you to sign in again (ports).
- While a team's AI Team Cloud Computer is updating or changing size, its files say "This usually
  takes about 5 to 6 minutes" instead of counting down a time left.
- Wake Team says "Waking Backend team... this usually takes 15-30 seconds" instead of "about 15 s",
  adds "Taking longer than usual, still working." after 30 seconds, and notices the team is running
  within about a second.
- On a Boost Max team (32 GB) Wake Team and the terminal say "this usually takes 30-45 seconds", and
  "Taking longer than usual, still working." waits for 45 seconds.
- Messages, prompts and the Ports view say "AI Team Cloud Computer" (or "Cloud Computer") where
  they said "team machine" or "machine", for example "AI Team Cloud Computer port to forward".
- Approving a sign-in with an account that signs in at another address now says which address to
  set in the host setting, and keeps nothing.

## 0.2.3

- A session open in more than one place (HQ in the browser and a VS Code terminal, or two VS Code
  windows) no longer garbles in the one that is not in front. The terminal in front sets the
  session's size (switching to it, focusing its window, or typing); the others draw at that size and
  redraw their screen once.

- Session terminals no longer say "Connection lost, reconnecting..." once an hour. HQ renews every
  connection hourly; the terminal now moves to a fresh connection a few minutes before, with nothing
  on screen and no keystroke lost or repeated. If a connection still drops, the terminal reconnects
  quietly and says so only when reconnecting takes more than a few seconds or it drops again.
- The live file updates in the Explorer move to a fresh connection the same way, so they no longer
  pause for a moment once an hour.

## 0.2.2

- **Paste or drop images into session terminals.** Press Cmd+V (macOS) or Ctrl+V (Windows, Linux)
  with an image copied, or drag image files onto the terminal: the image is added to the team's
  `.uploads` folder and its path typed at the prompt, as in HQ in the browser. Dragging an image
  from the team's own folder types its path with no upload. Files from your computer are uploaded
  only after you agree. PNG, JPEG, GIF and WebP, up to 10 MB. Text on the clipboard always pastes as
  text, exactly as before.
- A file shown masked because it holds a secret's value now updates by itself when that secret is
  removed or changed in HQ (within about 15 seconds), and a file that becomes masked when a secret is
  added does too. Opening a masked file says which secret, when you can use the team's terminals.
- Session terminals recover by themselves: a terminal that ended or lost its connection (for example
  after VS Code restarted its extensions) reconnects in place on the next key, and opening its
  session again gives a fresh terminal instead of the ended one. A session whose process restarts on
  the team machine clears and shows the new one, a temporary failure to reach HQ while reconnecting
  is retried instead of ending the terminal, and the terminal says when the session stops.
- After VS Code restarts its extensions, the HQ terminals that were open come back by themselves in
  fresh tabs (the old ones, which nothing answered any more, are closed). A restarted session is
  shown at the terminal's own width at once.

## 0.2.1

- The first published release of the 0.2 line. It contains everything listed under 0.2.0 below;
  0.2.0 itself was not published.

## 0.2.0

- **More than one HQ account.** Run **HQ: Add Another Account** to sign in to another account on
  the same HQ, for example your agency's and a client's. Each window uses one account, shown in the
  status bar; click it to switch. Two windows can work as two accounts at once.
- Each account is its own access, listed on its own in HQ under Account, Devices. Signing out of
  one, or HQ ending one, closes only that account's terminals and port forwards.
- The **Account** view lists every account signed in on this computer, each with **Sign out**. With
  more than one account, signing out asks first and names the account.
- Folders, terminals and port forwards stay with the account that opened them when you switch.
  With more than one account signed in, their names show which account, for example
  `Backend team (Acme) · owner@client`.
- Team folders opened with 0.1 keep working, with no sign-in after the update.
- The HQ approval page now says which account is approving, with **Not you? Sign out**.
- A team folder or file that was opened while its account was not signed in fills in by itself
  once you sign in as that account, with no Refresh.
- Signing out of one account of several names it: "Signed out of a@agency.com. Other accounts stay
  signed in."
- Team states (`running`, `off`) in the status bar and in the team picker stay current.
- The sign-in code notice closes once the sign-in is approved, cancelled or fails, and a dropped
  connection while waiting for the approval no longer ends the sign-in.
- A log for troubleshooting: **View, Output, AI Workforce One HQ**. It records sign-ins, accounts
  and sign-outs, never a token, a key, a code or file contents.
- Fixed: **Sign in** after "Your HQ sign-in needs renewing" could pick up the same expired sign-in
  again instead of starting a new one.
- A VS Code window left open no longer keeps a team machine awake: reconnecting by itself (about
  once an hour) does not count as you being there. Opening a team folder or terminal, opening or
  saving files, typing in a terminal and using a forwarded port still do. Windows still on 0.1
  count their hourly reconnects as you being there until they are updated to 0.2.0.

## 0.1.1

- Fixed: **Sign in** could do nothing but say "Signing in to AI Workforce One HQ from another VS Code window" when that window was closed, had crashed or was stuck mid-sign-in. A sign-in left behind by a window that is gone is now taken over at once, and none lasts longer than its sign-in code (about 10 minutes).
- When another window really is signing in, the message now offers **Sign in here instead**, which ends the sign-in there and starts one in this window.
- Clicking **Sign in** again in the window that is already signing in shows its code again.
- An open-website prompt left unanswered no longer holds up the sign-in.

## 0.1.0 (pre-release)

- Sign in with a device approval; your editor gets its own access, listed in HQ under Account, Devices.
- Teams sidebar: organizations, teams (running, starting, off) and sessions.
- Session terminals with instant local echo; Wake Team; New Session Terminal.
- Port forwarding to `localhost`, with listening ports offered.
