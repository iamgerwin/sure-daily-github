# Deployment Guide

This guide covers deploying Sure Daily GitHub on various VPS providers and configurations.

## Prerequisites

- VPS with Ubuntu 20.04+ / Debian 11+ / CentOS 8+ (or similar)
- Node.js 18+ installed
- GitHub Personal Access Token with `contents:write` permission
- SSH access to your VPS

## Quick VPS Setup

### 1. Connect to VPS

```bash
ssh user@your-vps-ip
```

### 2. Install Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verify installation
node --version  # Should be v18.x or higher
npm --version
```

### 3. Clone Repository

```bash
# Create app directory
mkdir -p ~/apps
cd ~/apps

# Clone your repository
git clone <your-repo-url> sure-daily-github
cd sure-daily-github

# Install dependencies
npm install --production
```

### 4. Configure Application

```bash
# Create configuration
node src/cli.js init

# Edit configuration
nano config/config.yaml

# Set your GitHub token
cp .env.example .env
nano .env
# Add: GITHUB_TOKEN=ghp_your_token_here
```

Update `config/config.yaml`:

```yaml
schedule:
  enabled: true           # Enable scheduler
  cron: "0 */6 * * *"    # Run every 6 hours

repositories:
  - owner: "yourusername"
    repo: "your-repo"
    enabled: true
    branch: "main"
    dailyTarget: 1
    path: "daily-updates"
    commitMessage: "docs: daily update ${date}"
```

### 5. Test Configuration

```bash
# Validate configuration
node src/cli.js validate

# Test with dry-run
node src/cli.js run --dry-run

# Run once for real
node src/cli.js run

# Check status
node src/cli.js status
```

## Deployment Options

### Option A: Systemd Service (Recommended)

Best for: Ubuntu, Debian, CentOS, RHEL, Fedora

```bash
# Edit service file with your paths
nano deployment/sure-daily-github.service

# Update these lines:
# User=your_username
# WorkingDirectory=/home/your_username/apps/sure-daily-github
# Environment="GITHUB_TOKEN=your_actual_token"
# ReadWritePaths=/home/your_username/apps/sure-daily-github/logs /home/your_username/apps/sure-daily-github/data

# Copy service file
sudo cp deployment/sure-daily-github.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable sure-daily-github

# Start service
sudo systemctl start sure-daily-github

# Check status
sudo systemctl status sure-daily-github

# View logs
sudo journalctl -u sure-daily-github -f

# Stop service
sudo systemctl stop sure-daily-github

# Restart service
sudo systemctl restart sure-daily-github
```

### Option B: PM2 Process Manager

Best for: Any Linux distribution, easy management

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start application
pm2 start src/cli.js --name "sure-daily-github" -- start

# Save PM2 process list
pm2 save

# Setup startup script (run on boot)
pm2 startup
# Follow the instructions shown

# Useful PM2 commands
pm2 list                    # List all processes
pm2 logs sure-daily-github  # View logs
pm2 stop sure-daily-github  # Stop process
pm2 restart sure-daily-github  # Restart process
pm2 delete sure-daily-github   # Remove process
pm2 monit                   # Monitor resources
```

### Option C: Cron Job

Best for: Minimal resource usage, simple setup

```bash
# Edit crontab
crontab -e

# Add this line (runs every 6 hours)
0 */6 * * * cd ~/apps/sure-daily-github && /usr/bin/node src/cli.js run >> ~/apps/sure-daily-github/logs/cron.log 2>&1

# For hourly execution
0 * * * * cd ~/apps/sure-daily-github && /usr/bin/node src/cli.js run >> ~/apps/sure-daily-github/logs/cron.log 2>&1

# View cron logs
tail -f ~/apps/sure-daily-github/logs/cron.log
```

### Option D: Docker (Advanced)

```bash
# Create Dockerfile
cat > Dockerfile <<EOF
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "src/cli.js", "start"]
EOF

# Build image
docker build -t sure-daily-github .

# Run container
docker run -d \
  --name sure-daily-github \
  --restart unless-stopped \
  -e GITHUB_TOKEN=your_token_here \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  sure-daily-github

# View logs
docker logs -f sure-daily-github

# Stop container
docker stop sure-daily-github

# Start container
docker start sure-daily-github
```

## VPS Provider Specific Guides

### DigitalOcean Droplet

```bash
# Create droplet (smallest tier: $4-6/month)
# Choose: Ubuntu 22.04 LTS, 1GB RAM, 1 vCPU

# After creation, follow "Quick VPS Setup" above
# Recommended: Use systemd service
```

### AWS EC2

```bash
# Launch instance: t2.micro (free tier eligible)
# AMI: Amazon Linux 2 or Ubuntu 22.04

# Connect
ssh -i your-key.pem ec2-user@your-instance-ip

# Follow "Quick VPS Setup" above
```

### Linode

```bash
# Create Linode: Nanode 1GB ($5/month)
# Distribution: Ubuntu 22.04 LTS

# Follow "Quick VPS Setup" above
```

### Vultr

```bash
# Deploy server: Cloud Compute, Regular Performance
# Smallest tier: 1GB RAM, 1 vCPU ($6/month)

# Follow "Quick VPS Setup" above
```

## Security Hardening

### 1. Use Environment Variables

Never hardcode tokens in configuration files:

```bash
# Store token securely
echo "GITHUB_TOKEN=ghp_xxxxx" > .env
chmod 600 .env  # Restrict file permissions
```

### 2. Firewall Configuration

```bash
# Ubuntu/Debian (UFW)
sudo ufw allow ssh
sudo ufw enable
# GitHub API only needs outbound connections

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
```

### 3. Regular Updates

```bash
# Update system
sudo apt update && sudo apt upgrade -y  # Ubuntu/Debian
sudo yum update -y                      # CentOS/RHEL

# Update application
cd ~/apps/sure-daily-github
git pull
npm install --production
sudo systemctl restart sure-daily-github  # If using systemd
```

### 4. Log Rotation

```bash
# Create logrotate config
sudo nano /etc/logrotate.d/sure-daily-github
```

Add:

```
/home/your_username/apps/sure-daily-github/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

## Monitoring

### Check Service Status

```bash
# Systemd
sudo systemctl status sure-daily-github

# PM2
pm2 status

# Cron
grep sure-daily-github /var/log/syslog  # Ubuntu/Debian
grep sure-daily-github /var/log/cron    # CentOS/RHEL
```

### View Logs

```bash
# Application logs
tail -f ~/apps/sure-daily-github/logs/*.log

# Systemd logs
sudo journalctl -u sure-daily-github -f

# PM2 logs
pm2 logs sure-daily-github
```

### Monitor Resources

```bash
# System resources
htop

# PM2 monitoring
pm2 monit

# Check disk space
df -h

# Check memory
free -h
```

## Troubleshooting

### Service Won't Start

```bash
# Check logs
sudo journalctl -u sure-daily-github -n 50

# Verify Node.js installation
node --version

# Test manually
cd ~/apps/sure-daily-github
node src/cli.js validate
node src/cli.js run --dry-run
```

### Authentication Errors

```bash
# Verify token
echo $GITHUB_TOKEN

# Test token manually
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user

# Check token permissions on GitHub
# https://github.com/settings/tokens
```

### Rate Limit Issues

```bash
# Check current rate limit
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/rate_limit

# Reduce frequency in config
nano config/config.yaml
# Change cron: "0 */12 * * *"  # Every 12 hours instead of 6
```

## Updating the Application

```bash
# Navigate to app directory
cd ~/apps/sure-daily-github

# Pull latest changes
git pull

# Install new dependencies
npm install --production

# Restart service
sudo systemctl restart sure-daily-github  # Systemd
pm2 restart sure-daily-github            # PM2
# Cron will pick up changes on next run
```

## Uninstallation

```bash
# Stop service
sudo systemctl stop sure-daily-github
sudo systemctl disable sure-daily-github
sudo rm /etc/systemd/system/sure-daily-github.service
sudo systemctl daemon-reload

# Or PM2
pm2 delete sure-daily-github
pm2 save

# Remove application
rm -rf ~/apps/sure-daily-github

# Remove cron job
crontab -e
# Delete the line with sure-daily-github
```

## Cost Estimates

### Cheapest VPS Options

| Provider | Plan | RAM | CPU | Storage | Price/Month |
|----------|------|-----|-----|---------|-------------|
| Vultr | Regular | 512MB | 1 vCPU | 10GB | $2.50 |
| DigitalOcean | Basic | 512MB | 1 vCPU | 10GB | $4.00 |
| Linode | Nanode | 1GB | 1 vCPU | 25GB | $5.00 |
| AWS | t2.micro | 1GB | 1 vCPU | 8GB | $0-8.50* |
| Hetzner | CX11 | 2GB | 1 vCPU | 20GB | €4.15 |

*AWS Free Tier: 750 hours/month free for first 12 months

### Recommended Minimum

- **RAM**: 512MB (1GB recommended)
- **CPU**: 1 vCPU
- **Storage**: 10GB
- **Network**: 500GB+ bandwidth
- **Cost**: $2.50-5.00/month

## Support

For deployment issues:
1. Check logs first
2. Verify configuration with `validate` command
3. Test with `--dry-run` flag
4. Review this guide
5. Open GitHub issue with logs and config (remove tokens!)
