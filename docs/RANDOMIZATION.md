# Randomization & Multi-Repository Features

This guide explains the advanced randomization and multi-repository selection features available in sure-daily-github.

## Table of Contents

- [Overview](#overview)
- [Range-Based Issue Counts](#range-based-issue-counts)
- [Randomization Configuration](#randomization-configuration)
- [Repository Selection Strategies](#repository-selection-strategies)
- [Time-Based Variations](#time-based-variations)
- [Configuration Examples](#configuration-examples)
- [Use Cases](#use-cases)

## Overview

The randomization features allow you to:

1. **Randomize issue/commit counts** - Generate a random number of issues within a specified range
2. **Multi-repository support** - Target multiple repositories with flexible selection strategies
3. **Time-based variations** - Adjust activity limits based on hourly/daily/weekly periods
4. **Weighted selection** - Prioritize certain repositories over others

These features create more organic-looking activity patterns and provide flexible automation control.

## Range-Based Issue Counts

### Basic Configuration

Instead of a fixed daily target, you can specify a range:

```yaml
general:
  dailyTarget:
    min: 12
    max: 50
```

This will randomly generate between 12 and 50 issues per execution.

### Repository-Specific Targets

Each repository can have its own target range:

```yaml
repositories:
  - owner: "yourusername"
    repo: "repo1"
    dailyTarget:
      min: 5
      max: 15

  - owner: "yourusername"
    repo: "repo2"
    dailyTarget: 10  # Fixed count still supported
```

## Randomization Configuration

### Enable Global Randomization

```yaml
randomization:
  enabled: true

  # Override issue count with custom range
  issueCount:
    min: 12
    max: 50
```

When randomization is enabled, it overrides individual repository `dailyTarget` ranges and uses the global `issueCount` range instead.

### Time-Based Variations

Control activity limits per time period:

```yaml
randomization:
  enabled: true

  timeVariations:
    enabled: true

    # Issues per hour
    hourly:
      min: 1
      max: 5

    # Issues per day
    daily:
      min: 10
      max: 30

    # Issues per week
    weekly:
      min: 50
      max: 150
```

The system automatically selects the appropriate time period based on your scheduler configuration.

## Repository Selection Strategies

Control which repositories are processed during each execution.

### Sequential (Default)

Process all repositories in order:

```yaml
repositorySelection:
  strategy: "sequential"
  randomizeOrder: false
  maxPerExecution: null  # Process all repos
```

### Random Selection

Randomly select repositories each execution:

```yaml
repositorySelection:
  strategy: "random"
  randomizeOrder: true
  maxPerExecution: 2  # Process 2 random repos
```

### Weighted Selection

Prioritize repositories based on weights:

```yaml
repositorySelection:
  strategy: "weighted"
  maxPerExecution: 2

repositories:
  - owner: "yourusername"
    repo: "high-priority"
    weight: 50  # 50% chance of selection

  - owner: "yourusername"
    repo: "medium-priority"
    weight: 30  # 30% chance

  - owner: "yourusername"
    repo: "low-priority"
    weight: 20  # 20% chance
```

### Round-Robin

Rotate through repositories systematically:

```yaml
repositorySelection:
  strategy: "round-robin"
  maxPerExecution: 1  # Process one repo at a time
```

## Configuration Examples

### Example 1: Random Daily Activity

Generate 10-30 issues per day across 3 repositories:

```yaml
general:
  timezone: "UTC"
  mode: "issue"
  dailyTarget:
    min: 10
    max: 30

schedule:
  enabled: true
  cron: "0 */6 * * *"  # Every 6 hours

repositories:
  - owner: "yourusername"
    repo: "repo1"
    enabled: true

  - owner: "yourusername"
    repo: "repo2"
    enabled: true

  - owner: "yourusername"
    repo: "repo3"
    enabled: true
```

### Example 2: Weighted Multi-Repository

Process 2 random repositories with weighted selection:

```yaml
general:
  timezone: "UTC"
  mode: "issue"
  dailyTarget:
    min: 5
    max: 15

randomization:
  enabled: true
  issueCount:
    min: 10
    max: 25

repositorySelection:
  strategy: "weighted"
  randomizeOrder: true
  maxPerExecution: 2

repositories:
  - owner: "yourusername"
    repo: "main-project"
    weight: 40
    labels: ["automated", "main"]

  - owner: "yourusername"
    repo: "side-project"
    weight: 35
    labels: ["automated", "side"]

  - owner: "yourusername"
    repo: "experimental"
    weight: 25
    labels: ["automated", "experimental"]
```

### Example 3: Time-Based Variations

Adjust activity based on time periods:

```yaml
general:
  timezone: "UTC"
  mode: "issue"

randomization:
  enabled: true

  timeVariations:
    enabled: true

    # Light activity per hour
    hourly:
      min: 1
      max: 3

    # Moderate daily activity
    daily:
      min: 10
      max: 20

    # Higher weekly targets
    weekly:
      min: 50
      max: 100

schedule:
  enabled: true
  cron: "0 */2 * * *"  # Every 2 hours

repositories:
  - owner: "yourusername"
    repo: "active-repo"
    enabled: true
```

## Use Cases

### 1. Organic Activity Patterns

Create natural-looking contribution patterns:

```yaml
general:
  dailyTarget: { min: 5, max: 20 }

repositorySelection:
  strategy: "random"
  randomizeOrder: true
  maxPerExecution: 2
```

### 2. Distributed Activity

Spread activity across multiple repositories:

```yaml
repositorySelection:
  strategy: "weighted"
  maxPerExecution: 3

repositories:
  - { owner: "user", repo: "repo1", weight: 30 }
  - { owner: "user", repo: "repo2", weight: 30 }
  - { owner: "user", repo: "repo3", weight: 20 }
  - { owner: "user", repo: "repo4", weight: 20 }
```

### 3. Controlled Randomization

Set boundaries while maintaining variability:

```yaml
randomization:
  enabled: true
  issueCount: { min: 15, max: 25 }

  timeVariations:
    enabled: true
    hourly: { min: 2, max: 4 }
    daily: { min: 15, max: 25 }
    weekly: { min: 70, max: 120 }
```

## Testing

Test your randomization configuration with dry-run mode:

```bash
# Test with dry run
node src/cli.js run --dry-run --config config/your-config.yaml

# Validate configuration
node src/cli.js validate --config config/your-config.yaml
```

The logs will show:
- Which repositories were selected
- How many issues would be created
- Which selection strategy was used

## Best Practices

1. **Start Conservative**: Begin with smaller ranges and adjust based on results
2. **Use Dry Run**: Always test new configurations with `--dry-run` first
3. **Monitor Logs**: Check logs to understand selection patterns
4. **Balance Weights**: Ensure repository weights add up sensibly
5. **Consider Rate Limits**: Factor in GitHub API rate limits when setting high ranges
6. **Time Variations**: Use time variations to match your actual work patterns

## Troubleshooting

### Issues Created Don't Match Range

- Check if `maxPerExecution` is limiting repository selection
- Verify `dailyTarget` vs `randomization.issueCount` configuration
- Review state tracking - daily limits may already be met

### Same Repositories Always Selected

- Verify `randomizeOrder: true` is set
- Check if `strategy: "random"` or `"weighted"` is properly configured
- Ensure multiple repositories are `enabled: true`

### Too Many API Calls

- Reduce `max` values in ranges
- Increase delays between operations
- Consider using larger `cron` intervals
- Set `maxPerExecution` to limit repositories per run

## Related Documentation

- [Scheduler Configuration](./SCHEDULER.md)
- [Configuration Examples](../config/config.example.yaml)
- [Main README](../README.md)
