# ✅ Setup Complete - Automated Issue Creator

## 🎯 What's Running
Your automated issue creator is now active and will create issues on:
- **Repository**: https://github.com/iamgerwin/connect_four
- **Frequency**: Every 3 minutes
- **Timezone**: Asia/Singapore

## 📊 Service Status

### Check if service is running:
```bash
sudo systemctl status sure-daily-github
```

### View live logs:
```bash
sudo journalctl -u sure-daily-github -f
```

### View recent logs:
```bash
sudo journalctl -u sure-daily-github -n 50
```

## 🛠️ Service Management

### Stop the service:
```bash
sudo systemctl stop sure-daily-github
```

### Start the service:
```bash
sudo systemctl start sure-daily-github
```

### Restart the service:
```bash
sudo systemctl restart sure-daily-github
```

### Disable auto-start on boot:
```bash
sudo systemctl disable sure-daily-github
```

### Enable auto-start on boot:
```bash
sudo systemctl enable sure-daily-github
```

## ⚙️ Configuration Files

### Main configuration:
```
/opt/sure-daily-github/config/config.yaml
```

Edit schedule, repository, or content template:
```bash
sudo nano /opt/sure-daily-github/config/config.yaml
sudo systemctl restart sure-daily-github
```

### Environment file (GitHub token):
```
/opt/sure-daily-github/.env
```

### Service file:
```
/etc/systemd/system/sure-daily-github.service
```

## 📝 Current Configuration

**Mode**: Issue Creation
**Schedule**: `*/3 * * * *` (every 3 minutes)
**Repository**: iamgerwin/connect_four
**Issue Title**: Automated Issue - ${date} ${time}

## 🔧 Modify Schedule

To change how often issues are created, edit the config:

```bash
sudo nano /opt/sure-daily-github/config/config.yaml
```

Common cron patterns:
- `*/3 * * * *` - Every 3 minutes (current)
- `*/5 * * * *` - Every 5 minutes
- `*/15 * * * *` - Every 15 minutes
- `0 * * * *` - Every hour
- `0 */6 * * *` - Every 6 hours

After editing, restart:
```bash
sudo systemctl restart sure-daily-github
```

## 📈 Monitor Issues

View created issues:
https://github.com/iamgerwin/connect_four/issues

First issue created:
https://github.com/iamgerwin/connect_four/issues/1

## 🔐 Security

- GitHub token stored securely in `/opt/sure-daily-github/.env` (600 permissions)
- Service runs as unprivileged user `suredaily`
- Token never logged or exposed
- To rotate token: Update `.env` file and restart service

## ⚠️ Important Notes

1. **Rate Limits**: GitHub has rate limits. Creating issues every 3 minutes = ~480 issues per day
2. **Repository Access**: Ensure the token has access to the repository
3. **Token Expiration**: Check token expiration date and renew when needed

## 🚨 Troubleshooting

### Service won't start:
```bash
sudo journalctl -u sure-daily-github -n 50
```

### No issues being created:
1. Check service is running: `sudo systemctl status sure-daily-github`
2. Check logs: `sudo journalctl -u sure-daily-github -f`
3. Verify token: `cat /opt/sure-daily-github/.env`
4. Test manually: `sudo su - suredaily -c "cd /opt/sure-daily-github && node src/cli.js run"`

### Permission errors:
```bash
sudo chown -R suredaily:suredaily /opt/sure-daily-github
```

## 📦 System Resources

Current usage:
- Memory: ~24 MB
- CPU: <1%
- Disk: ~100 MB

## 🔄 Update from Git

To pull latest changes:
```bash
cd /opt/sure-daily-github
sudo su - suredaily
git pull origin main
npm install
exit
sudo systemctl restart sure-daily-github
```

---

**Setup Date**: 2025-10-10
**VPS**: DigitalOcean Singapore (128.199.173.95)
**Status**: ✅ Active and Running
