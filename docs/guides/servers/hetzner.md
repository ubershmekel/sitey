# Hetzner Cloud Server Onboarding

This guide gets you from a fresh Hetzner account to a running Sitey instance.

## 1. Before you start

- Hetzner Cloud account with billing enabled
- A domain name (you will connect DNS later)
- A way to log in to the server:
  - SSH key (recommended): [ssh-keys.md](../ssh-keys.md)
  - Or Hetzner web console / another access method

## 2. Create a server in Hetzner Cloud

1. Open [Hetzner Cloud Console](https://console.hetzner.com/) and choose your
   project.
2. Click **Create Resource** → **Servers**.
3. Choose an image: **Ubuntu 24.04 LTS** (recommended).
4. Choose a server type with at least 2 GB RAM.
5. Check the IPv4 address box.
6. If using SSH keys, under SSH keys select or add your public key.
7. Create the server and wait for status `Running`.
8. Click the IP address at the top to copy it (should look like `5.12.34.56`).

## 3. Log into the server

- If using SSH:

  ```bash
  ssh root@<server-ip>
  ```

- If not using SSH, log in via Hetzner console or your chosen method.

## 4. Install Sitey

Run this on the server after you are logged in:

```bash
curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
```

The installer prints:

- `URL: http://<server-ip>`
- `Admin password: <one-time-password>`

## 5. Configure DNS next

Choose your DNS provider guide:

- [Namecheap](../dns/namecheap.md)
- [Amazon Route 53](../dns/route53.md)
- [GoDaddy](../dns/godaddy.md)

## Official provider docs

- [Hetzner: Creating a Server](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/)
- [Hetzner: Firewalls overview](https://docs.hetzner.com/cloud/firewalls/overview/)
- [Hetzner: Getting started with Firewalls](https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall/)
