#!/usr/bin/env node

import { Command } from 'commander';
import config from './config/loader.js';
import executor from './core/executor.js';
import scheduler from './core/scheduler.js';
import logger from './utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
);

const program = new Command();

program
  .name('sure-daily-github')
  .description('Lean automation for daily GitHub commits - VPS optimized')
  .version(packageJson.version);

// Run command - execute once
program
  .command('run')
  .description('Run once (manual trigger)')
  .option('--dry-run', 'Test mode without actual commits')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      const cfg = config.load(options.config);

      if (options.dryRun) {
        cfg.general.dryRun = true;
        console.log('🔍 Running in dry-run mode\n');
      }

      const result = await executor.execute(cfg);

      if (result.success) {
        console.log('\n✅ Execution completed successfully');
        console.log(`   Total: ${result.summary.total}`);
        console.log(`   Successful: ${result.summary.successful}`);
        console.log(`   Skipped: ${result.summary.skipped}`);
        console.log(`   Failed: ${result.summary.failed}`);
      } else {
        console.error('\n❌ Execution failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Start command - start scheduler
program
  .command('start')
  .description('Start scheduler (daemon mode)')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      const cfg = config.load(options.config);

      if (!cfg.schedule?.enabled) {
        console.error('❌ Scheduler is disabled in configuration');
        console.log('   Enable schedule.enabled in your config file');
        process.exit(1);
      }

      scheduler.start(cfg);

      console.log('✅ Scheduler started');
      console.log(`   Cron: ${cfg.schedule.cron}`);
      console.log(`   Timezone: ${cfg.schedule.timezone || cfg.general.timezone || 'UTC'}`);
      console.log(`   Logs: ./logs/`);
      console.log('\n   Press Ctrl+C to stop');

      // Keep process alive
      process.on('SIGINT', () => {
        console.log('\n\n⏹️  Stopping scheduler...');
        scheduler.stop();
        console.log('✅ Scheduler stopped');
        process.exit(0);
      });

      // Prevent process from exiting
      await new Promise(() => {});
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Status command - check repository status
program
  .command('status')
  .description('Check repository status')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      config.load(options.config);
      const result = await executor.getStatus();

      if (result.success) {
        console.log('\n📊 Repository Status\n');
        console.log('┌─────────────────────────────────┬────────┬───────┬────────┐');
        console.log('│ Repository                      │ Target │ Today │ Status │');
        console.log('├─────────────────────────────────┼────────┼───────┼────────┤');

        result.status.forEach(repo => {
          const repoName = `${repo.owner}/${repo.repo}`.padEnd(31);
          const target = repo.target.toString().padStart(6);
          const today = repo.today.toString().padStart(5);
          const status = repo.needsCommit ? '✗'.padStart(6) : '✓'.padStart(6);

          console.log(`│ ${repoName} │ ${target} │ ${today} │ ${status} │`);
        });

        console.log('└─────────────────────────────────┴────────┴───────┴────────┘\n');
      } else {
        console.error('❌ Failed to get status:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Validate command - validate configuration
program
  .command('validate')
  .description('Validate configuration file')
  .option('--config <path>', 'Path to configuration file')
  .action((options) => {
    try {
      const cfg = config.load(options.config);
      console.log('✅ Configuration is valid');
      console.log(`   Repositories: ${cfg.repositories.length}`);

      // Display dailyTarget nicely
      const target = cfg.general.dailyTarget;
      const targetStr = typeof target === 'object'
        ? `${target.min}-${target.max} (range)`
        : target;
      console.log(`   Daily target: ${targetStr}`);

      console.log(`   Scheduler: ${cfg.schedule?.enabled ? 'enabled' : 'disabled'}`);

      // Display randomization if enabled
      if (cfg.randomization?.enabled) {
        console.log(`   Randomization: enabled`);
      }

      // Display repository selection strategy
      if (cfg.repositorySelection?.strategy) {
        console.log(`   Selection: ${cfg.repositorySelection.strategy}`);
      }
    } catch (error) {
      console.error('❌ Configuration validation failed:');
      console.error('  ', error.message);
      process.exit(1);
    }
  });

// Init command - create example configuration
program
  .command('init')
  .description('Create example configuration')
  .action(() => {
    const configPath = path.join(process.cwd(), 'config', 'config.yaml');
    const configDir = path.dirname(configPath);

    if (fs.existsSync(configPath)) {
      console.log('⚠️  Configuration file already exists:', configPath);
      console.log('   Delete it first if you want to reinitialize');
      process.exit(1);
    }

    // Create config directory if it doesn't exist
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Create example config
    const exampleConfig = `# Sure Daily GitHub - Configuration

general:
  timezone: "UTC"
  dailyTarget: 1
  mode: "commit"
  dryRun: false

schedule:
  enabled: false
  cron: "0 */6 * * *"  # Every 6 hours
  timezone: "UTC"

repositories:
  - owner: "yourusername"
    repo: "your-repo"
    enabled: true
    branch: "main"
    dailyTarget: 1
    path: "daily-updates"
    commitMessage: "docs: daily update \${date}"

contentTemplate:
  title: "Daily Update"
  body: |
    # Daily Progress - \${date}

    Automated daily update.

    ---
    Generated at \${timestamp}
`;

    fs.writeFileSync(configPath, exampleConfig);
    console.log('✅ Configuration created:', configPath);
    console.log('\n📝 Next steps:');
    console.log('   1. Edit config/config.yaml with your repository details');
    console.log('   2. Set GITHUB_TOKEN environment variable');
    console.log('   3. Run: sure-daily-github validate');
    console.log('   4. Test: sure-daily-github run --dry-run');
  });

program.parse();
