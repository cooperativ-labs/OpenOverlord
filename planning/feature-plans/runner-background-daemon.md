# Runner Background Daemon — run the poller without occupying a terminal

**Status:** Proposal (planning only — no code in this ticket)
**Ticket:** coo:4 — *Automate job launch on run button click*
**Contract baseline:** `0.5-draft`
**Layer:** Runner Layer (`runner`) + CLI Layer (`cli`)
**Reference spec:** [`cli/docs/04-runner-and-launch-execution.md`](../../cli/docs/04-runner-and-launch-execution.md)

---

## 1. TL;DR

1. **The run button already works** once a runner is polling. Clicking *Run* in
   the webapp writes a `queued` row to `execution_requests`; a running
   `ovld runner start` claims it and `ovld launch` opens the agent in its own
   terminal window (via `terminal_launcher = "iTerm2"`). The user is happy with
   that launched-agent window.

2. **The actual pain is the poller, not the launch.** `ovld runner start` is a
   foreground `while (true) { runOnce(); sleep(3000) }` loop
   (`cli/src/commands.ts:850-853`). It blocks one terminal window for as long as
   you want auto-launch to work. The ask is: **let the poller run in the
   background instead of holding a terminal hostage.**

3. **Recommendation — ship both, in two phases:**
   - **Phase 1 (quick win, cross-platform):** `ovld runner start --detach`
     self-forks a detached background process, writes a PID + log file under
     `~/.ovld/runner/`, and returns the prompt immediately. Add
     `ovld runner stop` and teach `ovld runner status` to report the daemon. No
     OS integration, pure Node, works today on every platform.
   - **Phase 2 (always-on):** `ovld runner install-service` generates and loads
     an OS-native service (launchd `LaunchAgent` on macOS, `systemd --user`
     unit on Linux) so the poller starts at login, survives reboots, and
     auto-restarts on crash. This is the "Background service installation"
     already listed as *Future behavior* in the runner spec.

4. **Purely additive.** New `ovld runner` subcommands/flags and optional
   `[runner]` keys in `overlord.toml`. No protocol, schema, or closed-vocabulary
   changes — no contract version bump (see §7).

---

## 2. Current behavior (grounded in code)

| Piece | Where | What it does |
| --- | --- | --- |
| Run button → queue | REST → `execution_requests` (status `queued`) | Webapp enqueues a durable request in the **local** SQLite DB. |
| Poller loop | `cli/src/commands.ts:850-853` | `ovld runner start`: foreground infinite loop, `runOnce()` then `sleep(--poll-interval-ms`, default 3000). **Blocks the terminal.** |
| Claim + launch | `cli/src/commands.ts:785-835` | `runOnce()` atomically claims the oldest compatible request, `markExecutionLaunching`, `launchAgent(...)`, then `markExecutionLaunched`/`markExecutionFailed`. |
| Agent window | `terminal_launcher` (`overlord.toml`), `cli/src/terminal-launcher.ts`, `cli/src/launch.ts` | Opens the **agent** in a fresh iTerm2/Terminal window via AppleScript. **This is the part the user wants to keep.** |
| Device identity | `src/service/devices.ts:8-10` | Fingerprint = `sha256(hostname:platform)`, one local target per device. |
| State dir convention | `~/.ovld/` (`cli/src/connectors.ts:254`, `cli/src/native-session.ts:20`) | Existing home for CLI-local state. The daemon's PID/log belong here too. |

**Key distinction this proposal turns on:** there are *two* terminal-facing
processes. The **poller** (`runner start`) is long-lived and only needs to exist;
nobody needs to watch it. The **launched agent** is interactive and *should* get
its own window. Today both compete for terminal windows. We only need to move the
poller off-screen.

---

## 3. The options

| # | Option | Survives logout/reboot? | Auto-restart on crash? | OS work | Effort | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| A | `nohup ovld runner start &` (docs only, no code) | No | No | none | ~0 | Stopgap to document today |
| B | `ovld runner start --detach` + PID/stop/status | No (re-launch at login needed) | No | none | Low | **Phase 1 — ship first** |
| C | OS service: launchd / systemd `install-service` | **Yes** | **Yes** | per-OS templates | Medium | **Phase 2 — ship next** |
| D | Local webapp server spawns `ovld runner once` on enqueue | n/a (no separate poller) | n/a | webapp wiring | Medium | Alternative; see §6 |

Options B and C compose: B is the manual/dev-friendly path, C is the
"set-and-forget" path. D removes the poller concept entirely but couples runner
launch to the local web server's lifecycle — discussed but not recommended as the
primary fix.

---

## 4. Phase 1 — `ovld runner start --detach` (recommended first)

### 4.1 Behavior

```
ovld runner start --detach        # fork a background poller, print PID, return prompt
ovld runner status                # now also reports: "Runner daemon: running (pid 4821)" or "not running"
ovld runner stop                  # signal the daemon to exit, remove PID file
```

- `--detach` (alias `-d`) re-spawns the same `ovld runner start` invocation as a
  **detached** child (`spawn(process.execPath, [binPath, 'runner', 'start', ...flags], { detached: true, stdio: ['ignore', logFd, logFd] })`),
  then `child.unref()` and exit 0 in the parent. The child runs the existing
  loop unchanged.
- Forwards the operative flags it was given: `--project-id`, `--poll-interval-ms`,
  `--device-fingerprint`, `--terminal <launcher>` (so the launched agent still
  opens in iTerm2/Terminal as today).
- The detached child never inherits the parent TTY, so closing the terminal that
  ran `--detach` does not kill the poller.

### 4.2 PID + log files (under the existing `~/.ovld/` convention)

```
~/.ovld/runner/runner-<fingerprint>.pid    # daemon PID, keyed by device fingerprint
~/.ovld/runner/runner-<fingerprint>.log    # stdout/stderr of the loop (launch results, errors)
```

- Keying by **device fingerprint** (`src/service/devices.ts:8`) lets the design
  extend cleanly to per-project pollers later without colliding.
- On start the child writes its PID; on clean exit / `stop` it removes the file.
- `status` reads the PID file, checks liveness with `process.kill(pid, 0)`, and
  reaps a stale file if the process is gone (e.g. after a crash/reboot).

### 4.3 Single-instance guard

Before forking, `--detach` checks for a live PID file and refuses to start a
second poller for the same fingerprint (prevents two loops racing for claims).
`claimNextExecutionRequest` is already atomic (contract: *Runner → Database* is a
compare-and-set claim), so a duplicate poller is a correctness-safe annoyance, not
a data hazard — but we still block it for clarity and to avoid double terminal
windows.

### 4.4 Logging

Redirect the child's stdout/stderr to the log file so the "Launched <agent> for
<ticket>" / failure lines (`cli/src/commands.ts:811-824`) are captured. Add
`ovld runner logs [--follow]` (thin `tail -f` over the log) so the user can check
in without a foreground window. Optional simple size-cap rotation (truncate at N
MB) to avoid unbounded growth.

### 4.5 Why this first

Zero OS-specific code, works on macOS and Linux identically, and immediately
solves the stated problem ("don't take up a terminal window"). It's also the
substrate the service in Phase 2 supervises.

---

## 5. Phase 2 — `ovld runner install-service` (always-on)

For users who want auto-launch to "just work" after a reboot without remembering
to start anything.

```
ovld runner install-service     # generate + load the OS service, enable at login
ovld runner uninstall-service   # unload + remove
ovld runner status              # reports service state in addition to PID state
```

### 5.1 macOS — launchd LaunchAgent

Write `~/Library/LaunchAgents/io.cooperativ.overlord.runner.plist`:

- `ProgramArguments`: absolute `node` + absolute `ovld` bin + `runner start`
  (the **foreground** form — launchd is the supervisor, so no `--detach`).
- `RunAtLoad = true`, `KeepAlive = true` (auto-restart on crash).
- `WorkingDirectory` = resolved project dir; `StandardOutPath` /
  `StandardErrorPath` = the `~/.ovld/runner/*.log` file.
- `EnvironmentVariables`: pass through what `launchAgent` needs (PATH for the
  agent binary, `terminal_launcher` is read from `overlord.toml` so no secret env).
- Load with `launchctl bootstrap gui/$UID <plist>` (or legacy `launchctl load -w`).

> Note: AppleScript-driven `terminal_launcher` (iTerm2/Terminal) needs a GUI
> session, which is why this is a **LaunchAgent** (per-user, GUI), not a
> system-wide `LaunchDaemon`. Call this out in docs.

### 5.2 Linux — systemd user unit

Write `~/.config/systemd/user/overlord-runner.service` with
`ExecStart=<ovld> runner start`, `Restart=on-failure`, then
`systemctl --user enable --now overlord-runner`. (`loginctl enable-linger` if the
user wants it to run while logged out.)

### 5.3 Optional `[runner]` config in `overlord.toml`

Mirror the existing `terminal_launcher` precedent (config layer already owns this
file — see §7):

```toml
[runner]
# Start a background poller automatically; consumed by install-service / a future `ovld doctor`.
autostart = true
poll_interval_ms = 3000
# project_id = "..."   # restrict claims to one project
```

These are read by `install-service` to template the unit and by `runner status`
to explain expected vs actual state. Keep them **optional** with the same
defaults as the current flags.

---

## 6. Alternative D — local webapp spawns the runner (no separate poller)

The webapp server runs locally (`web_host`/`web_port`, default `127.0.0.1:4310`),
so it *can* spawn a process on the same machine. On creating an
`execution_request`, the REST handler could fire a detached `ovld runner once`
(claim-one-and-exit) instead of relying on a standing poller.

- **Pro:** no always-on poller; launch latency ~0 (no poll interval); the run
  button truly "just launches."
- **Con:** couples Runner-Layer launch to the **REST/webapp** process lifecycle
  and working directory, which the contract deliberately separates (Runner owns
  "execution_requests queue claiming and launch"; REST owns "HTTP surface"). It
  also only works while the web server is up and on the same host — it does not
  generalize to the future remote/SSH targets the runner spec anticipates.
- **Verdict:** attractive for a single-machine local instance, but it bypasses
  the queue's purpose (durable, target-routed, multi-runner claiming). Treat as a
  **later optimization layered on top of the queue**, not the primary fix. If
  pursued, it should still go through `execution_requests` + an atomic
  `runner once`, never launch the agent directly from the HTTP handler.

---

## 7. Contract impact

Per [`CONTRACT.md`](../../CONTRACT.md) maintenance rules, this work is **additive
and does not require a version bump**:

- **Runner Layer** already owns "`ovld runner` commands" and "execution target
  selection logic." New subcommands (`stop`, `install-service`,
  `uninstall-service`, `logs`) and the `--detach` flag are additions within that
  ownership, not changes to a stable interface.
- **CLI Layer** already owns "configuration file locations and formats
  (`overlord.toml` ...)". Adding an optional `[runner]` table parallels the
  existing `terminal_launcher` entry. **Action:** when implemented, extend the
  CLI registry line in `CONTRACT.md` §"CLI Layer → Owns" to name the new
  `[runner]` keys, exactly as `terminal_launcher` is named today (documentation
  update, not a version bump).
- **No** changes to `execution_requests.status`, protocol commands, or any closed
  vocabulary — none of the contract-version-bump triggers apply.
- The **Runner → Database** interaction surface is unchanged: the daemon still
  claims via the same atomic compare-and-set; running it detached or under
  launchd does not alter the claim semantics.

---

## 8. Edge cases & decisions to confirm

1. **Stale PID after crash/reboot (Phase 1):** `status`/`start` must detect a
   PID file whose process is dead and reap it rather than refuse to start.
2. **Two pollers:** single-instance guard per fingerprint (§4.3); safe but
   blocked for clarity.
3. **GUI requirement for AppleScript launch:** launchd path must be a
   per-user **LaunchAgent**, not a system daemon (§5.1). Headless/SSH sessions
   can't drive iTerm2 AppleScript — document that `terminal_launcher` needs a
   GUI login, and that `--no-terminal` (inline launch) is the headless fallback.
4. **Log growth:** start with a simple size cap; full rotation is out of scope.
5. **Windows:** out of scope for Phase 1/2 (platform is macOS/Linux today). The
   `--detach` path is portable in principle; a Windows service template can come
   later.

---

## 9. Acceptance criteria

- `ovld runner start --detach` returns the prompt immediately and the poller keeps
  claiming + launching after the originating terminal is closed.
- `ovld runner status` reports whether a background poller is running (PID) and,
  when Phase 2 lands, whether the OS service is installed/active.
- `ovld runner stop` cleanly terminates the background poller and removes the PID
  file; a stale PID file does not block a fresh start.
- Clicking *Run* in the webapp with a backgrounded poller launches the agent in
  its own terminal window exactly as it does today — no behavioral change to the
  launched-agent experience.
- (Phase 2) After `install-service` + reboot/login, a queued request is launched
  with no manual `ovld runner start`.
- No new terminal window is occupied by the poller itself in any of the above.

---

## 10. Suggested follow-up objectives (if approved)

1. Implement Phase 1: `--detach`, PID/log files under `~/.ovld/runner/`,
   `runner stop`, `runner status` daemon reporting, `runner logs`.
2. Implement Phase 2: `install-service`/`uninstall-service` for launchd +
   systemd, optional `[runner]` config, and the `CONTRACT.md` CLI-registry doc
   update.
3. Document the background-runner workflow in
   `cli/docs/04-runner-and-launch-execution.md` (promote it from *Future
   behavior* to *Supported*) and in the README.
