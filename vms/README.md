# Aperio VM and container installation tests

This directory contains disposable end-to-end installation tests. They are for
contributors and maintainers who need to answer:

> Does Aperio install on a clean machine, load native modules, create SQLite,
> start HTTP, and serve the setup page?

The tests do not replace unit tests, and they are not a way to run Aperio in
production. Never put real memories or secrets in a test guest or container.

## Choose a path

Run commands from the repository root.

| Question | Command | Host requirements |
| --- | --- | --- |
| I need the quickest isolated check | `npm run vmtest:docker -- --image aperio:test-local` | Docker Desktop |
| I need a clean Ubuntu installer test | `npm run vmtest:linux` | Apple-silicon Mac, Vagrant, Parallels Pro/Business |
| I need a clean Debian developer-style test | `npm run vmtest:linux:debian` | Apple-silicon Mac, Vagrant, Parallels Pro/Business |
| I need the macOS one-click installer test | `npm run vmtest:mac` | Prepared macOS ARM Parallels VM |
| I need the Windows one-click installer test | `npm run vmtest:windows` | Prepared Windows 11 ARM Parallels VM |
| I only need the common assertions | `bash vms/smoke.sh /path/to/aperio` | A staged install with `node_modules/` |

Most changes need only Docker. Use Ubuntu or Debian when native Linux
installation matters. Use macOS or Windows when testing the desktop installer
itself.

## A. First run: Docker

Install the host dependencies once:

```bash
cd /path/to/aperio
npm install
```

Build and test the image:

```bash
docker build -f docker/Dockerfile -t aperio:test-local .
npm run vmtest:docker -- --image aperio:test-local
```

The runner chooses a non-default host port, creates a temporary volume, starts
the image with SQLite/lite settings, checks `/api/bootstrap/state` and
`/setup.html`, captures logs, and removes the container and volume.

To debug with a known port or a longer readiness window:

```bash
VMTEST_DOCKER_PORT=31338 npm run vmtest:docker -- --image aperio:test-local
VMTEST_DOCKER_READY_ATTEMPTS=180 npm run vmtest:docker -- --image aperio:test-local
```

The runner never pulls a missing local tag. Published images must be passed as
a complete registry reference, preferably a digest:

```bash
npm run vmtest:docker -- --image ghcr.io/baiganio/aperio@sha256:<digest>
```

## B. Linux ARM64: Vagrant and Parallels

### Prerequisites

- Apple-silicon Mac.
- Vagrant 2.4 or newer.
- Parallels Desktop Pro or Business. The automated provider is not available
  in the Standard workflow.
- The Vagrant Parallels provider:

  ```bash
  vagrant plugin install vagrant-parallels
  ```

Check the tools before the first box download:

```bash
vagrant --version
vagrant plugin list | grep '^vagrant-parallels'
prlctl --version
```

### Run one profile

```bash
# Ubuntu 24.04 ARM64: local installer, smoke test, uninstall
npm run vmtest:linux

# Debian 12 ARM64: Git clone, npm install, migration, smoke test
npm run vmtest:linux:debian
```

Both profiles use 4 GB RAM and two CPUs. The host checkout is rsynced to
`/vagrant-repo`; `node_modules/`, `var/`, `.sqlite/`, and `vms/out/` are
excluded. Dependencies are installed inside the guest, so native binaries are
built for the guest architecture.

The Ubuntu profile tests the one-line installer and then uninstalls it. The
Debian profile models a developer clone and leaves its installed checkout in
the guest only until the wrapper destroys that guest.

Test another branch that exists in the staged checkout:

```bash
APERIO_BRANCH=my-branch npm run vmtest:linux
```

### If Vagrant is interrupted

The wrapper destroys the selected guest on success, failure, or interruption.
If the host or Parallels is killed, inspect before removing anything:

```bash
vagrant global-status
VAGRANT_CWD="$PWD/vms" vagrant status
```

Destroy only the profile you ran:

```bash
VAGRANT_CWD="$PWD/vms" vagrant destroy -f ubuntu-lite
VAGRANT_CWD="$PWD/vms" vagrant destroy -f debian-dev
```

Do not destroy Vagrant machines belonging to another project.

## C. Desktop installers: prepared Parallels guests

Desktop tests intentionally start from a machine with no Node or Aperio. The
macOS runner creates a linked clone and deletes it. The Windows runner resets a
named snapshot before each run and restores it afterward.

### macOS ARM

Create a macOS Apple-silicon guest using a compatible IPSW. Finish setup,
install Parallels Tools, confirm that `/Volumes/psf/` can see a host share, and
do not install Node or Aperio. Shut down the guest and name it:

```text
aperio-mac-pristine
```

Run:

```bash
npm run vmtest:mac
```

The runner creates `aperio-mac-run`, stages the repository read-only, runs the
real installer, runs the shared smoke contract, collects the guest log, and
deletes only `aperio-mac-run`. It never starts or deletes the pristine VM.

Override names when needed:

```bash
VMTEST_MAC_PRISTINE_VM=my-macos-pristine \
VMTEST_MAC_RUN_VM=my-macos-run \
npm run vmtest:mac
```

If a clone remains after an interrupted run, verify the exact name first:

```bash
prlctl list -a
prlctl stop aperio-mac-run --kill
prlctl delete aperio-mac-run --yes
```

Only use the last two commands for the disposable run clone, never the
pristine VM.

### Windows ARM

Create a Windows 11 ARM guest named `aperio-win-test`. Finish setup, create an
administrator test user, install Parallels Tools, and do not install Node or
Aperio. Shut it down and create the clean snapshot:

```bash
prlctl snapshot aperio-win-test -n clean
```

Run:

```bash
npm run vmtest:windows
```

The host stages the checkout read-only, attaches it as `AperioVmtest`, starts
the VM from `clean`, invokes `vms/win/run-guest.ps1`, collects the guest log,
and restores the snapshot. Override the VM or snapshot when your names differ:

```bash
VMTEST_WINDOWS_VM=my-win-vm \
VMTEST_WINDOWS_SNAPSHOT=my-clean-snapshot \
npm run vmtest:windows
```

## The shared smoke contract

`vms/smoke.sh` and `vms/smoke.ps1` are the common acceptance checklist. They
do not create a VM. Use them when the target directory already has a clean
install:

```bash
bash vms/smoke.sh /path/to/aperio
```

```powershell
.\vms\smoke.ps1 C:\path\to\aperio
```

The target must contain `package.json`, `node_modules`, `server.js`, `db/`,
and `public/`. The checklist verifies Node/npm, `better-sqlite3`, `sqlite-vec`,
`sharp`, SQLite migration, `/api/bootstrap/state`, `/setup.html`, and that
runtime state does not leak into the temporary home directory. It writes its
temporary database and server log under the target `.sqlite/` directory and
removes its temporary `HOME` on exit.

## Where the implementation lives

| Path | Responsibility |
| --- | --- |
| `Vagrantfile` | ARM64 boxes, resources, rsync exclusions, and guest provisioning |
| `run-vagrant.sh` | Selects a profile, streams host output, and destroys the guest |
| `smoke.sh`, `smoke.ps1` | Shared POSIX/Windows acceptance checks |
| `docker/run.sh` | Local or registry image smoke test and cleanup |
| `mac/run.sh`, `mac/run-guest.sh` | macOS clone lifecycle and guest install |
| `win/run.sh`, `win/run-guest.ps1` | Windows snapshot lifecycle and guest install |
| `out/` | Git-ignored, timestamped host evidence logs |

The design boundary is deliberate: host scripts own lifecycle and cleanup;
guest scripts install and test; the smoke contract contains the assertions.
When adding a platform, preserve that boundary and add a test under
`tests/vms/`.

## Logs and failure diagnosis

List the newest host logs:

```bash
ls -lt vms/out/
tail -200 vms/out/<latest-log>
```

Guest logs are `/tmp/aperio-vmtest.log` on Linux/macOS and
`C:\aperio-vmtest.log` on Windows. Docker logs and `docker inspect` output are
copied into the host log. Logs can contain private paths, prompts, or runtime
details: inspect only what is needed and redact before sharing.

Use the failure stage as your clue:

| Failure | First check |
| --- | --- |
| Provider missing | `vagrant plugin list`, `prlctl --version` |
| Guest never becomes ready | Parallels Tools, guest boot, and shared-folder visibility |
| Native import fails | Guest architecture and a fresh guest-side `npm install` |
| Docker image missing | Build the exact local tag; local tags are never pulled |
| Bootstrap timeout | Host log, container/guest log, and the selected port |
| Resource remains | Audit exact prefixed VM/container/volume names before cleanup |

For visual inspection, keep a test process running and tunnel its loopback port
from the host. Do not add a browser dependency to the smoke contract:

```bash
ssh -N -L 31337:127.0.0.1:31337 vm-user@vm-address
```

Open `http://127.0.0.1:31337` and stop the SSH process with Ctrl-C afterward.

## Verification before changing VM code

```bash
NODE_ENV=test node --test tests/integration/vms/smoke-contract.test.js
bash -n vms/smoke.sh vms/run-vagrant.sh vms/win/run.sh vms/mac/run.sh vms/docker/run.sh
ruby -c vms/Vagrantfile
```

The hosted workflows provide broader coverage: `ci.lite-smoke.yml` exercises
boot checks, `ci.install-matrix.yml` exercises installer/update/uninstall
paths, and `ci.docker-smoke.yml` exercises image smoke tests.
