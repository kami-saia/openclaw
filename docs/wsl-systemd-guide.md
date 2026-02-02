# WSL2 Systemd & DBus Fix Guide

**The Problem:**
On some WSL2 configurations (Ubuntu), the Systemd user session (`user@1000.service`) fails to initialize correctly on boot. This prevents the `dbus-user-session` from creating the required socket at `/run/user/1000/bus`.

**Symptoms:**
- `systemctl --user status` returns "Failed to connect to bus: No such file or directory".
- `openclaw gateway` fails to launch or crashes when starting the browser service.
- Chromium (Puppeteer) fails to launch with "Failed to connect to the bus".

**The Fix (Nuclear Option):**
Force Systemd to restart the user session slice. This triggers PAM and DBus to re-initialize.

```bash
sudo systemctl restart user@$(id -u).service
```

**Verification:**
After running the fix:
1. Check socket: `ls -la /run/user/$(id -u)/bus` (Should exist).
2. Check status: `systemctl --user status` (Should be active).

**Recommendation:**
Add an alias to `~/.bashrc` for easy recovery:
```bash
alias fix-systemd="sudo systemctl restart user@\$(id -u).service"
```
