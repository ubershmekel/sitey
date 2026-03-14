# SSH Keys for Server Access

Use SSH keys instead of passwords for server login. You only share the
**public** key with providers/servers. Keep the private key on your machine.

This guide is optional. If you are using another login method (provider web
console, temporary password login, SSM, etc.), you can still install Sitey
without SSH keys.

## 1. Generate a key pair

Run this on your local machine (remember to replace `you@example.com` with your
email):

```bash
ssh-keygen -t ed25519 -C "you@example.com"
```

Accept the default file path (`~/.ssh/id_ed25519`) and optionally set a
passphrase. A passphrase is the safer option, but is a bit less convenient.

## 2. Copy your public key

Linux/macOS:

```bash
cat ~/.ssh/id_ed25519.pub
```

Windows PowerShell:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Copy the full line that starts with `ssh-ed25519`.

## 3. Install the public key on the server

Normal flow: add your public key in the cloud provider UI during server
creation, then SSH in with that key.

If the server already exists, use one of these:

1. If you can already SSH in with another key/password:

   ```bash
   ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<server-ip>
   ```

2. If you only have provider web-console access, log in there and append your
   key to `~/.ssh/authorized_keys`:

   ```bash
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo "ssh-ed25519 AAAA... you@example.com" >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

## 4. Test SSH login

You can only run this step after a server already exists. If you do not have a
server yet, skip this for now and create one first:
[Hetzner](./servers/hetzner.md) or [AWS EC2](./servers/aws-ec2.md).

Hetzner (default user is usually `root`):

```bash
ssh root@<server-ip>
```

AWS Ubuntu (default user is usually `ubuntu`):

```bash
ssh ubuntu@<server-ip>
```
