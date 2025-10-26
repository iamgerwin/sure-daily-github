# Multi-Repository Automated Issue Setup

## Overview
Your automated GitHub issue reporting is now configured to spread issues across three repositories with randomized timing and content.

## Configuration Summary

### Repositories & Daily Targets

1. **manopo-web** (https://github.com/iamgerwin/manopo-web)
   - Daily target: 3-8 issues (randomized each day)
   - Interval between issues: 60-180 minutes (1-3 hours, randomized)
   - Labels: `automated`, `manopo-web`

2. **connect_four** (https://github.com/iamgerwin/connect_four)
   - Daily target: 5-10 issues (randomized each day)
   - Interval between issues: 60-180 minutes (1-3 hours, randomized)
   - Labels: `automated`, `connect-four`

3. **storetracker** (https://github.com/iamgerwin/storetracker)
   - Daily target: 2-5 issues (randomized each day)
   - Interval between issues: 60-180 minutes (1-3 hours, randomized)
   - Labels: `automated`, `storetracker`

### Timing & Schedule

- **Timezone**: Asia/Manila
- **Daily Reset**: 12:00 AM (midnight) Asia/Manila time
- **Scheduler Check**: Every 30 minutes
- **Issue Creation**: Spreads throughout the day with 1-3 hour intervals

### How It Works

1. **Daily Reset** (12:00 AM Asia/Manila):
   - System picks a random daily target for each repo (within the configured range)
   - Resets issue counters to 0

2. **Interval-Based Creation**:
   - After each issue is created, the system picks a random interval (60-180 minutes)
   - Next issue for that repo won't be created until the interval has passed
   - This spreads the issues naturally throughout the day

3. **Content Randomization**:
   - Each issue uses a random template (Bug, Feature, Documentation, or Performance)
   - Titles and descriptions are randomized from a predefined pool
   - Labels indicate the issue type and repository

## Files & Structure

```
/opt/sure-daily-github/
├── config/
│   └── config.yaml              # Main configuration file
├── src/
│   ├── github/
│   │   └── advanced-issue-handler.js  # Multi-repo issue handler
│   └── core/
│       └── executor.js          # Execution logic
├── data/
│   └── issue-state.json         # Tracks daily progress and next issue times
└── logs/                        # Application logs
```

## Monitoring & Management

### Check Status
```bash
npm run status
```

Shows:
- Current daily target for each repo
- Issues created today
- Next scheduled issue time

### Manual Run (Test)
```bash
npm run run -- --dry-run
```

Simulates issue creation without actually creating issues.

### Service Management
```bash
# Check service status
sudo systemctl status sure-daily-github

# View logs
sudo journalctl -u sure-daily-github -f

# Restart service
sudo systemctl restart sure-daily-github

# Stop service
sudo systemctl stop sure-daily-github
```

## Example Timeline

Here's how a typical day might look (times are in Asia/Manila):

**12:00 AM** - Daily reset
- manopo-web: Target set to 6 issues
- connect_four: Target set to 7 issues  
- storetracker: Target set to 3 issues

**12:30 AM** - First check
- manopo-web: Issue #1 created, next in 142 minutes (2:52 AM)
- connect_four: Issue #1 created, next in 87 minutes (1:57 AM)
- storetracker: Issue #1 created, next in 165 minutes (3:15 AM)

**1:00 AM** - Second check
- All repos waiting for their intervals...

**1:30 AM** - Third check
- All repos still waiting...

**2:00 AM** - Fourth check
- connect_four: Issue #2 created, next in 119 minutes (3:59 AM)

And so on throughout the day until all targets are reached!

## Issue Types

The system randomly creates these types of issues:

1. **Bug Reports** - Simulated bug discoveries
2. **Feature Requests** - Proposed new features
3. **Documentation** - Documentation improvements
4. **Performance** - Performance optimization suggestions

## Important Notes

1. **Rate Limiting**: The 1-3 hour intervals prevent GitHub API rate limiting
2. **Natural Distribution**: Issues are spread throughout the day, not bunched up
3. **Daily Variation**: Each day has a different number of issues within your specified ranges
4. **State Persistence**: Progress is saved in `data/issue-state.json`

## Customization

To adjust the configuration, edit `/opt/sure-daily-github/config/config.yaml`:

- Change daily targets: Modify `dailyTarget.min` and `dailyTarget.max`
- Adjust intervals: Modify `intervalMinutes.min` and `intervalMinutes.max`
- Add/remove repos: Add/remove entries in the `repositories` section
- Customize content: Modify the `contentTemplates` and `randomization` sections

After making changes, restart the service:
```bash
sudo systemctl restart sure-daily-github
```

## Troubleshooting

### No issues being created?
- Check service status: `sudo systemctl status sure-daily-github`
- Verify GitHub token: Check `.env` file has valid `GITHUB_TOKEN`
- Check logs: `sudo journalctl -u sure-daily-github -f`

### Issues created too frequently?
- Increase `intervalMinutes.min` and `intervalMinutes.max` in config
- Restart service after changes

### Want to disable a repository temporarily?
- Set `enabled: false` for that repo in `config/config.yaml`
- Restart service

---

**Setup Date**: October 26, 2025  
**System**: sure-daily-github v1.0.0  
**Service**: Running as systemd service
