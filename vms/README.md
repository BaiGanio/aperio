# Aperio installation smoke tests

This directory contains disposable installation checks. They answer a
different question from unit tests: can a clean machine install Aperio, load
the native modules, migrate SQLite, start HTTP, and serve the setup UI?

The shared contracts are `vms/smoke.sh` for POSIX environments and
`vms/smoke.ps1` for Windows. Both check Node/npm, `better-sqlite3`,
`sqlite-vec`, `sharp`, SQLite migration, `/api/bootstrap/state`, `/setup.html`,
and runtime home-directory hygiene.

Run commands from the repository root:

```bash
cd /path/to/aperio
npm install
```

Disposable guests never receive the host checkout's `node_modules/`, `var/`,
`.sqlite/`, or `vms/out/`. Dependencies are installed inside the target OS so
native binaries match its architecture.

## Quick command reference

| Command | Environment | What it exercises |
|---|---|---|
| `npm run vmtest:linux` | Ubuntu 24.04 ARM64 guest | One-liner install, native npm install, smoke, uninstall |
| `npm run vmtest:linux:debian` | Debian 12 ARM64 guest | Git clone, native npm install, migration, smoke |
| `npm run vmtest:windows` | Windows 11 ARM Parallels VM | Snapshot reset, `START.bat`, PowerShell smoke |
| `npm run vmtest:mac` | macOS ARM Parallels guest | Linked clone, one-liner install, native npm install, smoke |
| `npm run vmtest:docker -- --image aperio:test-local` | Docker | Isolated volume/port, container HTTP/UI smoke |

The local VM commands require an Apple-silicon Mac and Parallels. Docker only
requires a working Docker daemon. CI equivalents run on GitHub-hosted runners.

## Shared smoke contract

Use this directly when dependencies are already installed:

```bash
bash vms/smoke.sh /path/to/aperio
```

On Windows PowerShell:

```powershell
.\vms\smoke.ps1 C:\path\to\aperio
```

The argument must contain `package.json`, `node_modules`, `server.js`, `db/`,
and `public/`. A temporary port is selected automatically; set `VMTEST_PORT`
to force a specific port. The contract writes SQLite state and a server log
under the target `.sqlite/` directory and removes its temporary `HOME`.

## Linux ARM64: Vagrant + Parallels

### Prerequisites

- Apple-silicon Mac.
- Vagrant 2.4 or newer.
- Parallels Desktop Pro or Business. The provider/CLI automation is not
  available in the Standard workflow.
- The Vagrant Parallels provider:

  ```bash
  vagrant plugin install vagrant-parallels
  ```

Verify before starting a box download:

```bash
vagrant --version
vagrant plugin list | grep '^vagrant-parallels'
prlctl --version
```

### What runs

The Vagrantfile configures 4096 MB RAM and two CPUs per guest. It rsyncs the
checkout to `/vagrant-repo`, excluding host dependencies and runtime data.
The Ubuntu profile installs guest build tools, runs the local installer,
installs dependencies natively, runs smoke, uninstalls, and asserts that the
install directory disappeared. The Debian profile clones the staged checkout,
runs `npm install` and migration, then runs smoke.

### Commands

```bash
npm run vmtest:linux
npm run vmtest:linux:debian
```

By default the wrapper passes the current Git branch to the local guest clone.
To test a different branch that exists in the staged repository:

```bash
APERIO_BRANCH=my-branch npm run vmtest:linux
```

The wrapper destroys the selected VM on success, failure, or interruption.
Inspect or recover stale Vagrant state with:

```bash
vagrant global-status
VAGRANT_CWD="$PWD/vms" vagrant status
VAGRANT_CWD="$PWD/vms" vagrant destroy -f ubuntu-lite
VAGRANT_CWD="$PWD/vms" vagrant destroy -f debian-dev
```

Only destroy profiles shown by the audit commands; other projects may use the
same Vagrant installation.

## Windows ARM64: Parallels snapshot

### One-time setup

Create a Windows 11 ARM VM named `aperio-win-test`. In the guest:

1. Complete Windows setup and create an administrative test user.
2. Install Parallels Tools and reboot. `prlctl exec` and the shared folder
   require Tools.
3. Do not install Node or Aperio; the clean snapshot tests that path.
4. Shut down the guest and create the reset snapshot:

   ```bash
   prlctl snapshot aperio-win-test -n clean
   ```

### Run

```bash
npm run vmtest:windows
```

The host finds the `clean` snapshot, stages the checkout read-only without
host dependencies, adds the `AperioVmtest` share, starts the VM, waits for
Tools, and invokes `vms/win/run-guest.ps1`. The guest copies files to
`%TEMP%\aperio-vmtest-install`, runs the real `START.bat`, and runs
`vms/smoke.ps1`. The host collects `C:\aperio-vmtest.log`, kills the launcher
tree, detaches the share, and restores the snapshot.

Overrides:

```bash
VMTEST_WINDOWS_VM=other-vm npm run vmtest:windows
VMTEST_WINDOWS_SNAPSHOT=other-snapshot npm run vmtest:windows
VMTEST_WINDOWS_SNAPSHOT_ID='{snapshot-id}' npm run vmtest:windows
VMTEST_WINDOWS_GUEST_STAGE='C:\\Mac\\Home\\Users\\you\\aperio-vmtest-stage' \
  npm run vmtest:windows
```

If the VM uses a custom Parallels host-share mapping, `VMTEST_WINDOWS_GUEST_STAGE`
must be the guest-visible path, not the host staging directory.

## macOS ARM64: clone per run

### Why a guest

The host Mac has developer tools, caches, keychain state, and possibly
host-built native modules. This executor tests a clean Apple-silicon macOS
environment. It keeps a pristine VM named `aperio-mac-pristine`, creates a
linked clone named `aperio-mac-run`, and never starts or deletes the pristine
VM.

### One-time setup

Create a macOS ARM guest with Parallels’ macOS guest installer. Apple-silicon
guests use a compatible IPSW rather than an Intel ISO or old `.app` installer.
In the guest:

1. Complete macOS setup and create an administrator test user.
2. Install Parallels Tools and reboot; the runner needs guest execution and
   shared folders.
3. Confirm the host share appears under `/Volumes/psf/`.
4. Do not install Node or Aperio.
5. Shut down the guest and name it `aperio-mac-pristine`.

The GUI is recommended for initial setup. The corresponding CLI shape for a
downloaded IPSW is:

```bash
prlctl create aperio-mac-pristine -o macos --restore-image \
  "$HOME/Downloads/UniversalMac_Restore.ipsw"
prlctl start aperio-mac-pristine
```

Do not run `prlctl create` against an existing VM. Finish setup in Parallels,
then use the existing VM name.

### Run

```bash
npm run vmtest:mac
```

The host removes any stale run clone, stages the checkout read-only, creates a
linked clone, attaches the share, starts the clone, and waits for Tools. The
guest verifies `Darwin`/`arm64`, runs `.github/lite/install.sh` against the
staged local Git repository, installs dependencies natively, and runs
`vms/smoke.sh`. The exit trap collects logs, detaches the share, stops, and
deletes the disposable clone.

Overrides:

```bash
VMTEST_MAC_PRISTINE_VM=aperio-mac-pristine
VMTEST_MAC_RUN_VM=aperio-mac-run
VMTEST_MAC_SHARE_NAME=AperioVmtest
VMTEST_MAC_GUEST_STAGE=/Volumes/psf/AperioVmtest
VMTEST_MAC_READY_ATTEMPTS=90
```

For example:

```bash
VMTEST_MAC_PRISTINE_VM=my-macos-pristine npm run vmtest:mac
```

Audit an interrupted run:

```bash
prlctl list -a
```

If and only if the disposable clone remains, remove that exact name:

```bash
prlctl stop aperio-mac-run --kill || true
prlctl delete aperio-mac-run --yes
```

Never apply those commands to `aperio-mac-pristine`.

## Docker image smoke

### Local image

Build the production Dockerfile and smoke the local tag:

```bash
docker build -f docker/Dockerfile -t aperio:test-local .
npm run vmtest:docker -- --image aperio:test-local
```

The runner validates a local tag with `docker image inspect`; it never pulls a
missing local tag. It creates a temporary named volume mounted at `/app/var`,
chooses a host port other than 31337, sets SQLite/lite-profile environment
variables, records image metadata, polls bootstrap/UI endpoints, captures
container logs, and removes the container and volume in an exit trap.

Use a fixed alternate port or longer readiness window when debugging:

```bash
VMTEST_DOCKER_PORT=31338 \
  npm run vmtest:docker -- --image aperio:test-local
VMTEST_DOCKER_READY_ATTEMPTS=180 \
  npm run vmtest:docker -- --image aperio:test-local
```

### Published GHCR image

Pass a complete registry reference, preferably a digest:

```bash
npm run vmtest:docker -- \
  --image ghcr.io/baiganio/aperio@sha256:<digest>
```

Known registry references are pulled explicitly and then inspected. Public
images need no login; private images require `docker login ghcr.io` first.

Audit Docker state after a forced interruption:

```bash
docker ps -a --filter 'name=aperio-vmtest-'
docker volume ls --filter 'name=aperio-vmtest-'
```

## Logs and cleanup

Host executor logs are retained in git-ignored `vms/out/`:

```bash
ls -lt vms/out/
tail -200 vms/out/<latest-log>
```

Guest log locations are `/tmp/aperio-vmtest.log` on Linux/macOS and
`C:\aperio-vmtest.log` on Windows. Docker logs and `docker inspect` output are
copied into the host log. Runtime data may contain private conversation text,
paths, prompts, or operational details; inspect only what is needed and redact
it before sharing.

## CI and local verification

The workflows are triggered as follows:

| Workflow | Trigger | Coverage |
|---|---|---|
| `ci.lite-smoke.yml` | Push/PR paths or manual dispatch | Five hosted OS/architecture boot checks |
| `ci.install-matrix.yml` | Installer PR paths, nightly schedule, manual dispatch | Real installer/update/uninstall and ARM suites |
| `ci.docker-smoke.yml` | Docker PR paths or manual dispatch | Buildx local image and optional explicit GHCR smoke |

Before pushing VM changes, run:

```bash
NODE_ENV=test node --test tests/vms/*.test.js
bash -n vms/smoke.sh vms/run-vagrant.sh vms/win/run.sh vms/mac/run.sh vms/docker/run.sh
ruby -c vms/Vagrantfile
```

Dispatch `ci.install-matrix.yml` with `full_suite=true` for the full ARM suite.
Dispatch `ci.docker-smoke.yml` with a complete `ghcr.io/...@sha256:...` value
to test a published image.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `vagrant-parallels plugin is required` | Plugin missing or installed for another Vagrant | Run `vagrant plugin list`; install `vagrant-parallels`. |
| Vagrant box download fails or is slow | First-use download, disk, or network issue | Check disk, retry, then inspect `vagrant box list` and `vms/out/`. |
| `prlctl` is required | Parallels CLI unavailable | Install Parallels Pro/Business and verify `prlctl --version`. |
| Snapshot not found | VM/snapshot name differs | Set `VMTEST_WINDOWS_VM`, `VMTEST_WINDOWS_SNAPSHOT`, or the snapshot ID. |
| Guest Tools never become ready | Tools missing, guest still booting, or share path wrong | Install/reinstall Tools, reboot, confirm the share, and retry. |
| macOS guest is not `Darwin arm64` | Intel or wrong guest image | Create a new Apple-silicon macOS guest. |
| macOS clone remains | Forced termination or Parallels closed | Audit `prlctl list -a`; remove only `aperio-mac-run`. |
| `node_modules is missing` | Non-interactive installer cloned but did not launch | Run `npm install` in the target directory, then rerun smoke. Maintained executors do this explicitly. |
| Native module fails to load | Wrong-architecture install or incomplete build | Delete guest `node_modules`, rerun npm install, and inspect logs. |
| npm falls back to node-gyp | No matching native prebuild | Let compilation finish; compiler errors mean required build tools are missing. |
| Docker local image is missing | Tag was not built | Build `aperio:test-local`; the runner intentionally does not pull local tags. |
| Docker port is busy | Requested port is occupied | Unset `VMTEST_DOCKER_PORT` or choose another non-31337 port. |
| GHCR pull/authentication fails | Bad reference or private registry | Verify the exact tag/digest and run `docker login ghcr.io` if needed. |
| Resource remains after interruption | Process was forcibly killed | Use the executor-specific audit commands and remove only prefixed resources. |

## Visual inspection

The contracts are shell/HTTP checks. To inspect a guest UI, tunnel its loopback
port and open the forwarded address:

```bash
ssh -N -L 31337:127.0.0.1:31337 vm-user@vm-address
```

Open <http://127.0.0.1:31337> and stop the SSH process with Ctrl-C afterward.
