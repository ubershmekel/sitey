# Namecheap DNS Onboarding

Use this guide if your domain DNS is managed in Namecheap.

## 1. Confirm Namecheap is your DNS host

In Namecheap, open your domain and check **Nameservers**. If nameservers point
to another provider, manage DNS there instead.

## 2. Add root A record

In **Advanced DNS -> Host Records**, add:

- Type: `A Record`
- Host: `@`
- Value: `<your-server-ip>`
- TTL: `Automatic`

## 3. Add wildcard A record

Also add:

- Type: `A Record`
- Host: `*`
- Value: `<your-server-ip>`
- TTL: `Automatic`

The wildcard record lets new Sitey projects use subdomains without creating new
DNS records each time.

## 4. Remove conflicting records if needed

If you already have parking/forwarding/CNAME entries for `@` or `*`, adjust or
remove them so traffic resolves to your server IP.

## 5. Verify DNS resolution

```bash
dig +short yourdomain.com
dig +short test.yourdomain.com
```

Both should return your server IP.

## 6. Continue in Sitey

Add your domain in Sitey and deploy a project.

## Official provider docs

- [Namecheap: How to create an A record for your domain](https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/)
- [Namecheap: How to create a wildcard record](https://www.namecheap.com/support/knowledgebase/article.aspx/10027/2237/how-to-create-a-wildcard-record-for-domain/)
