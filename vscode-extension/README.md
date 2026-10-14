# AI Workforce One HQ for VS Code

Your AI Workforce One HQ teams inside VS Code, Cursor, Windsurf and VSCodium, without installing
anything on your AI Team Cloud Computers. This is a pre-release.

- **Sign in** with the same device approval as the `hq` command line tool: run **HQ: Sign In**,
  enter the code on the HQ page that opens, and approve this computer. It gets its own access,
  which you can remove at any time in HQ, under Account, Devices. You can sign in to more than one
  HQ account; each window uses one, chosen in the status bar.
- **Teams**: the AI Workforce One HQ sidebar lists your organizations, their teams (running,
  starting or off) and each team's sessions.
- **Team files**: **Open Team Files** adds a team's folder to the Explorer. Open, edit and save its
  files, and search them on the AI Team Cloud Computer with **Search in Team Files**.
- **Session terminals**: open any session you can see in a VS Code terminal. You type in your own
  sessions; other people's sessions are view only. Closing the terminal leaves the session running.
  Wake Team starts an AI Team Cloud Computer that is off; New Session Terminal starts a new HQ session.
  Start, Stop and Restart Session act on a session from the HQ sidebar (the session owner or a team owner only).
- **Ports**: forward a port from an AI Team Cloud Computer to `localhost` on this computer and open it in
  your browser. Ports the Cloud Computer is listening on are offered for you.

Everything goes through HQ's own permissions: your role on each team, your plan, and your
organization's Developer access setting. Secrets stay masked, exactly as in HQ.

Guides, every command and setting, and troubleshooting:
[hq.aiworkforceone.com/docs/vscode](https://hq.aiworkforceone.com/docs/vscode/).

## Privacy

The extension sends no telemetry. It talks only to your HQ address (`hq.host`). Your sign-in is
kept in the editor's secret storage on this computer, and team file contents only in its memory.

## Security notes

- **Where the sign-in is kept.** In the editor's secret storage, which is the system keychain on
  macOS and Windows and the Secret Service (for example GNOME Keyring or KWallet) on Linux. On Linux
  without a keyring, the editor stores secrets with weaker protection; the extension then says so
  once. Remove this computer in HQ, under Account, Devices, to end its access from anywhere.
- **More than one account.** Each HQ account signed in here is its own device access, with its own
  row in HQ under Account, Devices, and can be removed on its own. Folders, terminals and port
  forwards always work as the account that opened them.
- **Team files.** The extension never runs anything from team files. Files that hold masked secret
  values, and protected template files, open read only.
- **Forwarded ports.** A forwarded port listens on `127.0.0.1` only, so other computers cannot reach
  it. Any program on this computer can, while the forward is open, as with any local port. On the
  AI Team Cloud Computer, a forward reaches whatever program listens on that port, including other members'
  dev servers. HQ refuses the Cloud Computer's own service ports, the Docker API ports (2375 and 2376), the
  Node debugger ports (9229 and 9230) and editor bridge ports.

## Settings

| Setting           | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `hq.localEcho`    | Show what you type in a session terminal at once (`auto`, `always` or `off`). |
| `hq.host`         | The HQ address (AI Workforce One staff only).                                 |
| `hq.allowedHosts` | Extra HQ addresses this editor may use (AI Workforce One staff only).         |
