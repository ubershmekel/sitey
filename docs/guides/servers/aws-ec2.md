# AWS EC2 Server Onboarding

This guide gets you from a fresh AWS account to a running Sitey instance on
EC2.

## 1. Before you start

- AWS account with billing enabled
- A domain name
- A way to log in to the instance:
  - SSH key (recommended): [ssh-keys.md](../ssh-keys.md)
  - Or EC2 Instance Connect / SSM / another access method

## 2. Choose your instance access method

- If using SSH keys:
  1. Open AWS Console, then **EC2**.
  2. Go to **Network & Security -> Key Pairs**.
  3. Click **Import key pair** and paste your public key.
- If not using SSH keys:
  - Plan to use EC2 Instance Connect or SSM Session Manager to open a shell.

## 3. Launch an Ubuntu instance

1. In EC2, click **Launch instance**.
2. AMI: choose **Ubuntu Server 24.04 LTS**.
3. Instance type: choose at least `t3.small` (or equivalent).
4. Key pair: select the imported key pair if using SSH, or proceed with your
   non-SSH access method.
5. Security group inbound rules:
   - SSH `22` from **My IP** (if using SSH)
   - HTTP `80` from `0.0.0.0/0`
   - HTTPS `443` from `0.0.0.0/0`
6. Launch the instance.

## 4. (Recommended) Attach an Elastic IP

Without an Elastic IP, your public IP can change after stop/start, which breaks
DNS. Allocate and associate an Elastic IP to this instance.

## 5. Log into the instance

- If using SSH (Ubuntu AMIs):

  ```bash
  ssh ubuntu@<public-ip-or-elastic-ip>
  ```

- Otherwise, open a shell with EC2 Instance Connect or SSM.

## 6. Install Sitey

Run this on the instance after you are logged in:

```bash
curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
```

The installer prints:

- `URL: http://<server-ip>`
- `Admin password: <one-time-password>`

## 7. Configure DNS next

Choose your DNS provider guide:

- [Namecheap](../dns/namecheap.md)
- [Amazon Route 53](../dns/route53.md)
- [GoDaddy](../dns/godaddy.md)

## Official provider docs

- [AWS EC2: Launch an instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EC2_GetStarted.html)
- [AWS EC2: Create key pairs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-key-pairs.html)
- [AWS EC2: Connect to your Linux instance using SSH](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-linux-inst-ssh.html)
- [AWS EC2: Security group rules for different use cases](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html)
- [AWS EC2: Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)
