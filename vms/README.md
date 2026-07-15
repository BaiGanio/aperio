# VM installation smoke contract

This contract checks the installed runtime, native modules, SQLite migrations, HTTP
bootstrap, setup-page delivery, and runtime hygiene without requiring a desktop in the VM.

```bash
bash vms/smoke.sh /path/to/aperio
```

On Windows PowerShell:

```powershell
.\vms\smoke.ps1 C:\path\to\aperio
```

For visual inspection from a shell-only VM, tunnel the loopback port to the Mac:

```bash
ssh -N -L 31337:127.0.0.1:31337 vm-user@vm-address
```

Then open `http://127.0.0.1:31337` in the Mac browser. VM executors and Docker runners
will be added after this contract is green.
