# Changelog

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
