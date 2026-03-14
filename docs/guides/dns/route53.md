# Amazon Route 53 DNS Onboarding

Use this guide if your domain DNS is managed by Amazon Route 53.

## 1. Create a public hosted zone

In AWS Route 53:

1. Open **Hosted zones**.
2. Create a **Public hosted zone** for your domain.

If your domain is registered outside AWS, copy the Route 53 nameservers and set
them at your registrar.

## 2. Add root A record

In the hosted zone, create:

- Record name: leave blank (root/apex)
- Record type: `A`
- Value: `<your-server-ip>` (or Elastic IP)
- TTL: `300` (or your preferred value)

## 3. Add wildcard A record

Create another record:

- Record name: `*`
- Record type: `A`
- Value: `<your-server-ip>` (or Elastic IP)
- TTL: `300`

## 4. Verify DNS resolution

```bash
dig +short yourdomain.com
dig +short test.yourdomain.com
```

Both should return your server IP.

## 5. Continue in Sitey

Add your domain in Sitey and deploy a project.

## Official provider docs

- [Amazon Route 53: Creating records by using the console](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html)
- [Amazon Route 53: Working with hosted zones](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-working-with.html)
- [Amazon Route 53: Domain name format](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)
