# GoDaddy DNS Onboarding

Use this guide if your domain DNS is managed by GoDaddy.

## 1. Confirm GoDaddy is your DNS host

Open your domain in GoDaddy and check the nameserver setting. If nameservers
point elsewhere, manage DNS at that provider.

## 2. Add root A record

In the DNS records page, add:

- Type: `A`
- Name: `@`
- Data/Value: `<your-server-ip>`
- TTL: default or `600`

## 3. Add wildcard A record

Add another record:

- Type: `A`
- Name: `*`
- Data/Value: `<your-server-ip>`
- TTL: default or `600`

If wildcard is blocked in your current DNS setup, add explicit subdomain A
records for each project until wildcard is available.

## 4. Remove conflicting records if needed

If `@` or `*` already point elsewhere (old hosting, forwarding, or parking),
update/remove those records so traffic resolves to your Sitey server IP.

## 5. Verify DNS resolution

```bash
dig +short yourdomain.com
dig +short test.yourdomain.com
```

Both should return your server IP.

## 6. Continue in Sitey

Add your domain in Sitey and deploy a project.

## Official provider docs

- [GoDaddy: Add DNS records](https://www.godaddy.com/help/add-dns-records-1920)
- [GoDaddy: Edit an A record](https://www.godaddy.com/help/edit-an-a-record-19239)
