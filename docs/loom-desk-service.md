# loom-desk managed-service runbook

`bored` runs as a **systemd user service** owned by `beckett`. It exposes its
HTTP API only on loopback at **`127.0.0.1:7770`**. Its health endpoint is:

```text
http://127.0.0.1:7770/health
```

A healthy response is HTTP 200 with `{"ok":true}`. This service does not add a
public tunnel or change Beckett's dispatch layer.

## Service definition

The committed source of truth is
[`deploy/systemd/bored.service`](../deploy/systemd/bored.service). The installer
copies that exact file to `~/.config/systemd/user/bored.service` and writes its
runtime settings to `~/.config/bored/bored.env` (mode 0600). The unit is:

```ini
[Unit]
Description=bored ticket tracker and workflow engine
Documentation=https://github.com/frgmt0/bored/blob/main/docs/loom-desk-service.md
After=network.target

[Service]
Type=simple
Environment=NODE_ENV=production
EnvironmentFile=%h/.config/bored/bored.env
ExecStart=/usr/bin/env ${BORED_NODE} ${BORED_CLI} serve --root ${BORED_ROOT} --repo ${BORED_REPO} --worker ${BORED_WORKER} --port ${BORED_PORT} --max-workers ${BORED_MAX_WORKERS} --owner-dm ${BORED_OWNER_DM}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=45s

[Install]
WantedBy=default.target
```

`Restart=on-failure` restarts a crash after five seconds. `WantedBy=default.target`
makes the unit start with the user manager. The installer also runs `loginctl
enable-linger beckett`, which keeps that user manager available after boot even
before an interactive login.

## Install or update on loom-desk

Run this as the `beckett` account from the checked-out canonical
`frgmt0/bored` repository. Pull/build first; the installer also runs `npm ci`
and `npm run build`, so it is safe to re-run after an update.

```bash
cd /home/beckett/Projects/bored
git pull --ff-only origin main
./scripts/install-systemd-user-service.sh \
  --repo /home/beckett/beckett \
  --worker 'THE CONFIGURED AGENT DRIVER COMMAND' \
  --port 7770 \
  --start
```

`--repo` is the git checkout in which bored will create worker worktrees; it is
not necessarily the bored checkout. `--worker` is deliberately required: it
must be the approved JSONL-driver command for a spawned seat, not a shell
placeholder. To inspect the available options:

```bash
./scripts/install-systemd-user-service.sh --help
```

The script is idempotent: it rebuilds the selected checkout, atomically
rewrites `~/.config/bored/bored.env`, installs the unit, reloads systemd,
enables it, and enables lingering. Omit `--start` to install/enable without
changing the currently running service. The service has no root privileges and
no system-wide unit.

## Verify health

After a start or restart, wait briefly and require both systemd and HTTP to be
healthy:

```bash
systemctl --user is-active --quiet bored.service
curl --fail --silent --show-error http://127.0.0.1:7770/health
# {"ok":true}
```

## Operations

```bash
# start / stop / restart
systemctl --user start bored.service
systemctl --user stop bored.service
systemctl --user restart bored.service

# status and live logs
systemctl --user status bored.service
journalctl --user -u bored.service -f
journalctl --user -u bored.service --since '1 hour ago'

# check the local API
curl --fail --silent --show-error http://127.0.0.1:7770/health
```

To change the worker command, repository, state root, port, owner target, or
worker cap, rerun the installer with those options and `--start`. Do not edit
the generated environment file while the service is being restarted.

## Worker-sandbox handoff

This branch does **not** invoke `systemctl --user enable --now bored.service`
on the live loom-desk user manager: doing so from the worker sandbox could
replace a live backend with an unreviewed worker command. The install script
has been syntax-checked and the built server's `/health` endpoint has been
verified locally. Beckett should courier the install command above, with the
approved worker driver, and perform the final live enable/start and health
check.
