# SSH Key Setup for DigitalOcean VPS

This guide covers setting up SSH keys for secure access to your DigitalOcean VPS.

## ✅ SSH Key Generated

Your new SSH key pair has been created:

**Location:**
- Private key: `~/.ssh/id_ed25519_digitalocean` (keep this secret!)
- Public key: `~/.ssh/id_ed25519_digitalocean.pub`

**Key Type:** ED25519 (modern, secure, fast)

**Fingerprint:** `SHA256:dWdalp71HNRlvTJCmSGT/ZoRca22Ub5acrscnrYUX5E`

---

## 📋 Your Public Key

Copy this **entire** public key to add to DigitalOcean:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPZ7oKaeFYsSo5K/y0UTn9oOtUyaHvLAmLUAsZ075eWW gerwin-digitalocean-vps
```

---

## 🚀 Step 1: Add SSH Key to DigitalOcean

### Option A: Via DigitalOcean Web Dashboard

1. **Login to DigitalOcean:**
   - Go to https://cloud.digitalocean.com
   - Login with your account

2. **Navigate to SSH Keys:**
   - Click your profile icon (top right)
   - Click **Settings**
   - Click **Security** tab
   - Scroll to **SSH Keys** section
   - Click **Add SSH Key**

3. **Add the Public Key:**
   - Paste the public key from above
   - Give it a name: `gerwin-digitalocean-vps`
   - Click **Add SSH Key**

### Option B: Via DigitalOcean CLI (doctl)

```bash
# Install doctl if not already installed
brew install doctl  # macOS
# or
snap install doctl  # Linux

# Authenticate
doctl auth init

# Add SSH key
doctl compute ssh-key create gerwin-digitalocean-vps \
  --public-key "$(cat ~/.ssh/id_ed25519_digitalocean.pub)"

# Verify
doctl compute ssh-key list
```

---

## 🖥️ Step 2: Create or Access Your Droplet

### Creating a New Droplet

1. **Go to Droplets:**
   - Click **Create** → **Droplets**

2. **Choose Configuration:**
   - **Region**: Singapore (closest to Manila)
   - **Image**: Ubuntu 22.04 LTS
   - **Size**: Basic - $6/month (1GB RAM, 1 vCPU, 25GB SSD)
   - **Authentication**: Select your SSH key `gerwin-digitalocean-vps`
   - **Hostname**: `sure-daily-github` (or your choice)

3. **Create Droplet:**
   - Click **Create Droplet**
   - Wait for it to provision (~60 seconds)
   - Note the IP address

### Using Existing Droplet

If you already have a droplet:

1. **Add SSH Key to Existing Droplet:**
   ```bash
   # From your local machine
   ssh-copy-id -i ~/.ssh/id_ed25519_digitalocean.pub root@YOUR_DROPLET_IP
   ```

   Or manually:
   ```bash
   # SSH into your droplet (with existing access)
   ssh root@YOUR_DROPLET_IP

   # Add the public key
   mkdir -p ~/.ssh
   echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPZ7oKaeFYsSo5K/y0UTn9oOtUyaHvLAmLUAsZ075eWW gerwin-digitalocean-vps" >> ~/.ssh/authorized_keys

   # Set permissions
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/authorized_keys
   ```

---

## 🔐 Step 3: Configure SSH on Your Local Machine

Create or update your SSH config for easy access:

```bash
# Edit SSH config
nano ~/.ssh/config
```

Add this configuration:

```
# DigitalOcean VPS for Sure Daily GitHub
Host do-daily-github
    HostName YOUR_DROPLET_IP
    User root
    IdentityFile ~/.ssh/id_ed25519_digitalocean
    IdentitiesOnly yes

# Optional: More secure settings
    ServerAliveInterval 60
    ServerAliveCountMax 3
    TCPKeepAlive yes
```

Replace `YOUR_DROPLET_IP` with your actual droplet IP address.

Save and set permissions:

```bash
chmod 600 ~/.ssh/config
```

---

## ✅ Step 4: Test SSH Connection

### Test Connection

```bash
# Using the SSH config alias
ssh do-daily-github

# Or directly
ssh -i ~/.ssh/id_ed25519_digitalocean root@YOUR_DROPLET_IP
```

**Expected Output:**
```
Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-88-generic x86_64)
...
root@sure-daily-github:~#
```

If you see this, **SSH is working!** 🎉

### Troubleshooting Connection Issues

**Permission denied:**
```bash
# Check key permissions
ls -la ~/.ssh/id_ed25519_digitalocean*
# Should be: -rw------- (600) for private key

# Fix if needed
chmod 600 ~/.ssh/id_ed25519_digitalocean
```

**Connection refused:**
```bash
# Check if droplet is running
# Verify IP address is correct
ping YOUR_DROPLET_IP

# Check SSH service on droplet
# (requires console access via DigitalOcean web)
systemctl status sshd
```

**Debug connection:**
```bash
# Verbose SSH output
ssh -vvv -i ~/.ssh/id_ed25519_digitalocean root@YOUR_DROPLET_IP
```

---

## 🔒 Step 5: Secure Your VPS (Recommended)

### Disable Password Authentication

Once SSH key works, disable password login for better security:

```bash
# SSH into your droplet
ssh do-daily-github

# Edit SSH config
sudo nano /etc/ssh/sshd_config

# Change these lines:
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password

# Restart SSH
sudo systemctl restart sshd
```

### Create Non-Root User (Optional but Recommended)

```bash
# Create new user
adduser gerwin

# Add to sudo group
usermod -aG sudo gerwin

# Copy SSH keys to new user
mkdir -p /home/gerwin/.ssh
cp ~/.ssh/authorized_keys /home/gerwin/.ssh/
chown -R gerwin:gerwin /home/gerwin/.ssh
chmod 700 /home/gerwin/.ssh
chmod 600 /home/gerwin/.ssh/authorized_keys

# Test new user login (from local machine)
ssh -i ~/.ssh/id_ed25519_digitalocean gerwin@YOUR_DROPLET_IP
```

Update SSH config:
```
Host do-daily-github
    HostName YOUR_DROPLET_IP
    User gerwin  # Changed from root
    IdentityFile ~/.ssh/id_ed25519_digitalocean
```

### Setup Firewall

```bash
# SSH into droplet
ssh do-daily-github

# Enable UFW firewall
sudo ufw allow OpenSSH
sudo ufw enable

# Verify
sudo ufw status
```

---

## 📦 Step 6: Deploy Sure Daily GitHub

Now that SSH is set up, deploy the application:

```bash
# SSH into your VPS
ssh do-daily-github

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone repository
git clone https://github.com/iamgerwin/sure-daily-github.git
cd sure-daily-github

# Install dependencies
npm install --production

# Setup configuration
cp .env.example .env
nano .env  # Add your GITHUB_TOKEN

# Initialize config
node src/cli.js init
nano config/config.yaml  # Configure your repositories

# Test
node src/cli.js validate
node src/cli.js run --dry-run

# Setup systemd service (optional)
sudo cp deployment/sure-daily-github.service /etc/systemd/system/
sudo nano /etc/systemd/system/sure-daily-github.service  # Update paths and token
sudo systemctl daemon-reload
sudo systemctl enable sure-daily-github
sudo systemctl start sure-daily-github

# Check status
sudo systemctl status sure-daily-github
```

---

## 📝 Quick Reference

### SSH Key Files

| File | Location | Purpose | Permissions |
|------|----------|---------|-------------|
| Private Key | `~/.ssh/id_ed25519_digitalocean` | Your secret key (never share!) | 600 (-rw-------) |
| Public Key | `~/.ssh/id_ed25519_digitalocean.pub` | Add to DigitalOcean/servers | 644 (-rw-r--r--) |
| SSH Config | `~/.ssh/config` | Connection shortcuts | 600 (-rw-------) |

### Common Commands

```bash
# Connect to VPS
ssh do-daily-github

# Copy file to VPS
scp file.txt do-daily-github:/path/to/destination/

# Copy file from VPS
scp do-daily-github:/path/to/file.txt ./local/path/

# Run command on VPS without login
ssh do-daily-github "systemctl status sure-daily-github"

# View SSH key fingerprint
ssh-keygen -lf ~/.ssh/id_ed25519_digitalocean.pub

# Copy public key to clipboard (macOS)
pbcopy < ~/.ssh/id_ed25519_digitalocean.pub

# Copy public key to clipboard (Linux)
xclip -sel clip < ~/.ssh/id_ed25519_digitalocean.pub
```

---

## 🛡️ Security Best Practices

### ✅ Do's

- ✅ Keep private key secure (never share, never commit to git)
- ✅ Use SSH keys instead of passwords
- ✅ Use ED25519 keys (modern, secure)
- ✅ Enable firewall on VPS
- ✅ Keep system updated
- ✅ Use non-root user for daily operations
- ✅ Backup your SSH keys securely

### ❌ Don'ts

- ❌ Never share your private key
- ❌ Never commit private keys to git
- ❌ Don't use weak passwords
- ❌ Don't disable firewall
- ❌ Don't run everything as root
- ❌ Don't expose unnecessary ports

---

## 🔄 Backup Your SSH Keys

**Secure backup locations:**

1. **Encrypted USB drive**
2. **Password manager** (1Password, LastPass, Bitwarden)
3. **Encrypted cloud storage** (encrypted before upload)

**Backup command:**
```bash
# Create encrypted backup
tar czf ssh-backup.tar.gz ~/.ssh/id_ed25519_digitalocean*
gpg -c ssh-backup.tar.gz  # Will prompt for password
rm ssh-backup.tar.gz

# Store ssh-backup.tar.gz.gpg in secure location
```

**Restore from backup:**
```bash
# Decrypt
gpg -d ssh-backup.tar.gz.gpg > ssh-backup.tar.gz

# Extract
tar xzf ssh-backup.tar.gz -C ~/

# Set permissions
chmod 600 ~/.ssh/id_ed25519_digitalocean
chmod 644 ~/.ssh/id_ed25519_digitalocean.pub
```

---

## 📞 Support

**DigitalOcean Issues:**
- Support: https://www.digitalocean.com/support
- Community: https://www.digitalocean.com/community

**SSH Issues:**
- SSH Documentation: https://www.openssh.com/manual.html
- DigitalOcean SSH Tutorial: https://www.digitalocean.com/community/tutorials/ssh-essentials-working-with-ssh-servers-clients-and-keys

---

**Generated:** 2025-10-10
**Key Comment:** gerwin-digitalocean-vps
**Key Type:** ED25519 256-bit
