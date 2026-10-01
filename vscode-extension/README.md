# AI Workforce One HQ for VS Code

Your AI Workforce One HQ teams inside VS Code, Cursor, Windsurf and VSCodium, without SSH and
without installing anything on your team machines.

- **Sign in** with the same device approval as the `hq` command line tool: run **HQ: Sign In**,
  enter the code on the HQ page that opens, and approve this computer. It gets its own access,
  which you can remove at any time in HQ, under Account, Devices.
- **Teams**: the AI Workforce One HQ sidebar lists your organizations, their teams (running,
  starting or off) and each team's sessions.
- **Session terminals**: open any session you can see in a VS Code terminal. You type in your own
  sessions; other people's sessions are view only. Closing the terminal leaves the session running.
  Wake Team starts a team machine that is off; New Session Terminal starts a new HQ session.
- **Ports**: forward a port from a team machine to `localhost` on this computer and open it in
  your browser. Ports the machine is listening on are offered for you.

Everything goes through HQ's own permissions: your role on each team, your plan, and your
organization's Developer access setting. Secrets stay masked, exactly as in HQ.

## Privacy

The extension sends no telemetry. It talks only to your HQ address (`hq.host`). Your sign-in is
kept in the editor's secret storage on this computer.

## Security notes

- **Where the sign-in is kept.** In the editor's secret storage, which is the system keychain on
  macOS and Windows and the Secret Service (for example GNOME Keyring or KWallet) on Linux. On Linux
  without a keyring, the editor stores secrets with weaker protection; the extension then says so
  once. Remove this computer in HQ, under Account, Devices, to end its access from anywhere.
- **Forwarded ports.** A forwarded port listens on `127.0.0.1` only, so other computers cannot reach
  it. Any program on this computer can, while the forward is open, as with any local port. On the
  team machine, a forward reaches whatever program listens on that port, including other members'
  dev servers. HQ refuses the machine's own service ports, the Node debugger ports (9229 and 9230)
  and editor bridge ports.

## Settings

| Setting           | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `hq.localEcho`    | Show what you type in a session terminal at once (`auto`, `always` or `off`). |
| `hq.host`         | The HQ address (AI Workforce One staff only).                                 |
| `hq.allowedHosts` | Extra HQ addresses this editor may use (AI Workforce One staff only).         |
