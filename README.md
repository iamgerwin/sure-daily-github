# Sure Daily GitHub

> Lean automation for daily GitHub commits - VPS optimized

A minimal Node.js automation tool that ensures consistent GitHub activity with configurable daily commit targets. Built specifically for low-resource VPS deployment.

## Features

- 🚀 **Lightweight** - Minimal dependencies, <50MB memory footprint
- 🔒 **Secure** - Environment-based token management, input validation
- ⏰ **Scheduled** - Cron-based automation with timezone support
- 📊 **Trackable** - State management to avoid duplicate commits
- 🧪 **Testable** - Dry-run mode for safe testing
- 🖥️ **VPS-Ready** - Systemd service included for production deployment

## Quick Start

### 1. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd sure-daily-github

# Install dependencies
npm install

# Make CLI executable (if needed)
chmod +x src/cli.js

# Link CLI globally (optional)
npm link
```

### 2. Configuration

```bash
# Create example configuration
node src/cli.js init

# Edit the configuration
nano config/config.yaml
```

Update `config/config.yaml` with your repository details:

```yaml
repositories:
  - owner: "yourusername"
    repo: "your-repo"
    enabled: true
    branch: "main"
    dailyTarget: 1
    path: "daily-updates"
    commitMessage: "docs: daily update ${date}"
```

### 3. GitHub Token Setup

Create a GitHub Personal Access Token:

1. Go to https://github.com/settings/tokens
2. Click "Generate new token" → "Fine-grained tokens"
3. Set permissions: `contents:write`
4. Copy the token

Set the environment variable:

```bash
# Create .env file
cp .env.example .env

# Edit and add your token
echo "GITHUB_TOKEN=ghp_your_token_here" > .env
```

### 4. Test

```bash
# Validate configuration
node src/cli.js validate

# Test with dry-run (no actual commits)
node src/cli.js run --dry-run

# Check repository status
node src/cli.js status
```

### 5. Run

```bash
# Run once manually
node src/cli.js run

# Start scheduler (keeps running)
node src/cli.js start
```

## CLI Commands

```bash
sure-daily-github init              # Create example configuration
sure-daily-github validate          # Validate configuration file
sure-daily-github run [--dry-run]   # Run once (manual trigger)
sure-daily-github start             # Start scheduler (daemon mode)
sure-daily-github status            # Check repository status
sure-daily-github --help            # Show all commands
```

## VPS Deployment

### Option 1: Systemd Service (Recommended)

Create a systemd service for automatic startup and management.

```bash
# Copy service file
sudo cp deployment/sure-daily-github.service /etc/systemd/system/

# Edit service file with your paths
sudo nano /etc/systemd/system/sure-daily-github.service

# Update these lines:
#   WorkingDirectory=/path/to/sure-daily-github
#   Environment="GITHUB_TOKEN=your_token"

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable sure-daily-github
sudo systemctl start sure-daily-github

# Check status
sudo systemctl status sure-daily-github

# View logs
sudo journalctl -u sure-daily-github -f
```

### Option 2: PM2 Process Manager

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start src/cli.js --name "sure-daily-github" -- start

# Save PM2 process list
pm2 save

# Setup PM2 startup script
pm2 startup
```

### Option 3: Cron (Simplest)

```bash
# Edit crontab
crontab -e

# Add entry to run every 6 hours
0 */6 * * * cd /path/to/sure-daily-github && /usr/bin/node src/cli.js run >> /var/log/sure-daily-github.log 2>&1
```

## Configuration Reference

### General Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timezone` | string | `UTC` | Default timezone |
| `dailyTarget` | number | `1` | Minimum commits per day (1-10) |
| `mode` | string | `commit` | Operation mode: `commit` or `issue` |
| `dryRun` | boolean | `false` | Test mode without actual commits |

### Schedule Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable automatic scheduling |
| `cron` | string | `"0 */6 * * *"` | Cron expression |
| `timezone` | string | `UTC` | Scheduler timezone |

### Repository Settings

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `owner` | string | ✅ | GitHub username/organization |
| `repo` | string | ✅ | Repository name |
| `enabled` | boolean | ❌ | Enable/disable repository (default: true) |
| `branch` | string | ❌ | Target branch (default: main) |
| `dailyTarget` | number | ❌ | Override global target |
| `path` | string | ❌ | Path for commits (default: daily-updates) |
| `commitMessage` | string | ❌ | Commit message template |

## Security Best Practices

- ✅ Never commit `.env` files
- ✅ Use fine-grained tokens with minimum permissions (`contents:write`)
- ✅ Rotate tokens regularly (set expiration dates)
- ✅ Use environment variables for all secrets
- ✅ Validate all configuration inputs
- ✅ Enable rate limiting (built-in)
- ✅ Review logs regularly

## Troubleshooting

### Authentication Failed

```bash
# Check token format
echo $GITHUB_TOKEN

# Should start with ghp_ or github_pat_

# Test authentication
node src/cli.js validate
```

### Rate Limit Issues

The tool includes automatic rate limiting and retry logic. If you hit rate limits:

- Reduce `dailyTarget` values
- Increase time between scheduled runs
- Check remaining rate limit: logs will show current limits

### Permission Errors

Ensure your GitHub token has:
- `contents:write` permission for commits
- Access to target repositories

## Resource Usage

Typical resource usage on VPS:
- **Memory**: 30-50 MB
- **CPU**: <1% (idle), 2-5% (during execution)
- **Disk**: <100 MB including node_modules
- **Network**: Minimal (only GitHub API calls)

Recommended VPS specs:
- 512 MB RAM minimum
- 1 vCPU
- 10 GB disk space

## Development

```bash
# Run tests (if implemented)
npm test

# Run with debug logging
LOG_LEVEL=debug node src/cli.js run

# Format code (if using prettier)
npm run format

# Lint code (if using eslint)
npm run lint
```

## Project Structure

```
sure-daily-github/
├── src/
│   ├── cli.js              # CLI entry point
│   ├── core/
│   │   ├── scheduler.js    # Cron scheduling
│   │   └── executor.js     # Main execution logic
│   ├── github/
│   │   ├── client.js       # GitHub API client
│   │   └── commit-handler.js
│   ├── config/
│   │   └── loader.js       # Configuration loader
│   └── utils/
│       ├── logger.js       # Logging utility
│       └── state.js        # State management
├── config/
│   └── config.example.yaml
├── deployment/
│   └── sure-daily-github.service
├── .env.example
└── package.json
```

## License

MIT

## Contributing

Contributions are welcome! Please ensure:
- Code follows existing patterns
- Security best practices are maintained
- Documentation is updated
- No credentials in commits

## Support

For issues, questions, or contributions:
- Open an issue on GitHub
- Check logs in `./logs/` directory
- Review configuration with `validate` command
