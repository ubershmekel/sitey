# Guide to Self-Hosting

This guide set helps first-time operators go from "no server" to a working
Sitey install with a real domain and HTTPS.

## Information architecture

```text
docs/guides/
|-- README.md                 # this table of contents and recommended flow
|-- ssh-keys.md               # generate and install SSH keys
|-- servers/
|   |-- hetzner.md            # create a Hetzner Cloud server for Sitey
|   `-- aws-ec2.md            # create an AWS EC2 server for Sitey
`-- dns/
    |-- namecheap.md          # DNS setup for Namecheap
    |-- route53.md            # DNS setup for Amazon Route 53
    `-- godaddy.md            # DNS setup for GoDaddy
```

## Recommended onboarding flow

1. Choose how you will access your server.
   SSH key auth is recommended, but not required.
   If you want SSH key auth, use: [SSH keys guide](./ssh-keys.md)
2. Create your server (pick one):
   [Hetzner](./servers/hetzner.md) or [AWS EC2](./servers/aws-ec2.md)
3. Log into the server (SSH, provider console, or another method) and install
   Sitey:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
   ```

4. Point DNS for your domain (pick one):
   [Namecheap](./dns/namecheap.md),
   [Amazon Route 53](./dns/route53.md), or
   [GoDaddy](./dns/godaddy.md)
5. In Sitey, add your domain and create your first project.

## If you need deeper operations docs

Use [docs/ops.md](../ops.md) for upgrades, resets, HTTPS details, and account
recovery commands.
