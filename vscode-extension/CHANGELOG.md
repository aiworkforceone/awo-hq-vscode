# Changelog

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
