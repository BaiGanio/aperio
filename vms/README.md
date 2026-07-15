# VM installation smoke tests

The shared smoke contract checks the installed runtime, native modules, SQLite
migrations, HTTP bootstrap, setup-page delivery, and runtime hygiene.

```bash
bash vms/smoke.sh /path/to/aperio
```

On Windows PowerShell:

```powershell
.\vms\smoke.ps1 C:\path\to\aperio
```

## Linux ARM64: Vagrant + Parallels

Prerequisites on an Apple Silicon Mac:

- Vagrant 2.4 or newer
- Parallels Desktop Pro or Business (the CLI automation used here is not
  available in Standard)
- `vagrant-parallels`:

  ```bash
  vagrant plugin install vagrant-parallels
  ```

Run either disposable profile:

```bash
npm run vmtest:linux          # Ubuntu 24.04 ARM64, one-liner installer
npm run vmtest:linux:debian   # Debian 12 ARM64, clone + npm install
```

The executor uses the native Parallels ARM64 provider, syncs the checkout from
the repository root, and excludes `node_modules/`, `var/`, `.sqlite/`, and
`vms/out/`. Each run collects output under `vms/out/` and destroys the VM on
success, failure, or interruption.

## Windows ARM64: Parallels snapshot

Create a Windows 11 ARM VM once in Parallels, install Parallels Tools, name it
`aperio-win-test`, and create a snapshot named `clean` while Node.js is absent:

```bash
prlctl snapshot aperio-win-test -n clean
```

Then run:

```bash
npm run vmtest:windows
```

The runner switches to `clean`, stages the checkout through a Parallels shared
folder without host `node_modules/`, starts the real `START.bat` flow, runs
`vms/smoke.ps1`, collects the guest transcript, stops the VM, and restores the
snapshot. It requires the default Parallels Windows host share mapping. Override
the guest staging path when the VM uses a custom mapping:

```bash
VMTEST_WINDOWS_GUEST_STAGE='C:\\Mac\\Home\\Users\\you\\aperio-vmtest-stage' \
  npm run vmtest:windows
```

If the snapshot listing format does not expose the ID in its first column, pass
the ID explicitly with `VMTEST_WINDOWS_SNAPSHOT_ID`. Logs are written to
`vms/out/`.

## Visual inspection

The smoke contract is intentionally shell-only. For visual inspection, tunnel
the loopback port to the Mac:

```bash
ssh -N -L 31337:127.0.0.1:31337 vm-user@vm-address
```

Then open `http://127.0.0.1:31337` in the Mac browser.
