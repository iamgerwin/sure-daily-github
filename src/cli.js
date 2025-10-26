#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import executor from './core/executor.js';
import scheduler from './core/scheduler.js';
import config from './config/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('sure-daily-github')
  .description(packageJson.description)
  .version(packageJson.version);

// Run command - execute once
program
  .command('run')
  .description('Execute once')
  .option('--dry-run', 'Simulate without making actual changes')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      const cfg = config.load(options.config);

      if (options.dryRun) {
        cfg.general.dryRun = true;
      }

      const result = await executor.execute(cfg);

      if (result.success) {
        console.log('\n✅ Execution completed\n');
        console.log(`Total:      ${result.summary.total}`);
        console.log(`Successful: ${result.summary.successful}`);
        console.log(`Skipped:    ${result.summary.skipped}`);
        console.log(`Failed:     ${result.summary.failed}\n`);
      } else {
        console.error('❌ Execution failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Start command - run scheduler
program
  .command('start')
  .description('Start the scheduler')
  .option('--config <path>', 'Path to configuration file')
  .action((options) => {
    try {
      const cfg = config.load(options.config);

      if (!cfg.schedule?.enabled) {
        console.error('❌ Scheduler is disabled in configuration');
        console.log('\nTo enable scheduling, set schedule.enabled to true in your config file.');
        console.log('Then define schedule.cron (e.g., "0 0 * * *" for daily at midnight).');
        process.exit(1);
      }

      scheduler.start(cfg);

      console.log('\n🚀 Sure Daily GitHub - Scheduler Started\n');
      console.log(`Schedule:  ${cfg.schedule.cron}`);
      console.log(`Timezone:  ${cfg.schedule.timezone || cfg.general.timezone}`);
      console.log(`Logs:      ./logs/\n`);
      console.log('Press Ctrl+C to stop\n');

      // Keep process alive
      process.on('SIGINT', () => {
        console.log('\n\n👋 Stopping scheduler...');
        scheduler.stop();
        process.exit(0);
      });
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
        
        // Check if it's the advanced handler format (has repositories array)
        if (result.status.repositories && Array.isArray(result.status.repositories)) {
          console.log('┌─────────────────────────────────┬────────────┬───────┬──────────────────────┐');
          console.log('│ Repository                      │ Target     │ Today │ Next Issue           │');
          console.log('├─────────────────────────────────┼────────────┼───────┼──────────────────────┤');

          result.status.repositories.forEach(repo => {
            const repoName = repo.repo.padEnd(31);
            const target = (repo.todayTarget || 'N/A').toString().padStart(10);
            const today = (repo.issuesCreatedToday || 0).toString().padStart(5);
            let nextIssue = 'Any time';
            
            if (repo.nextIssueTime && repo.nextIssueTime !== 'Any time') {
              const nextDate = new Date(repo.nextIssueTime);
              nextIssue = nextDate.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: false 
              });
            }
            
            nextIssue = nextIssue.padStart(20);

            console.log(`│ ${repoName} │ ${target} │ ${today} │ ${nextIssue} │`);
          });

          console.log('└─────────────────────────────────┴────────────┴───────┴──────────────────────┘\n');
          
          if (result.status.lastDailyReset) {
            const resetDate = new Date(result.status.lastDailyReset);
            console.log(`Last daily reset: ${resetDate.toLocaleString()}\n`);
          }
        } 
        // Legacy format
        else if (Array.isArray(result.status)) {
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
        }
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
      if (cfg.general.dailyTarget) {
        const target = cfg.general.dailyTarget;
        const targetStr = typeof target === 'object' 
          ? `${target.min}-${target.max}` 
          : target.toString();
        console.log(`   Daily target: ${targetStr}`);
      }

      console.log(`   Scheduler: ${cfg.schedule?.enabled ? 'enabled' : 'disabled'}`);
      
      if (cfg.randomization?.enabled) {
        console.log('   Randomization: enabled');
      }
      
      if (cfg.repositorySelection?.strategy) {
        console.log(`   Strategy: ${cfg.repositorySelection.strategy}`);
      }
    } catch (error) {
      console.error('❌ Configuration validation failed:', error.message);
      process.exit(1);
    }
  });

// Init command - create initial configuration
program
  .command('init')
  .description('Create initial configuration file')
  .action(async () => {
    try {
      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      const configPath = 'config/config.yaml';

      if (existsSync(configPath)) {
        console.log('⚠️  Configuration file already exists:', configPath);
        process.exit(1);
      }

      if (!existsSync('config')) {
        mkdirSync('config', { recursive: true });
      }

      const exampleConfig = `# Sure Daily GitHub - Configuration
general:
  timezone: "UTC"
  mode: "commit"
  dryRun: false

schedule:
  enabled: false
  cron: "0 0 * * *"
  timezone: "UTC"

repositories:
  - owner: "yourusername"
    repo: "your-repo"
    enabled: true
    branch: "main"

contentTemplate:
  message: "Automated commit - \${timestamp}"
`;

      writeFileSync(configPath, exampleConfig);
      console.log('✅ Configuration file created:', configPath);
      console.log('\nNext steps:');
      console.log('1. Edit config/config.yaml with your settings');
      console.log('2. Set GITHUB_TOKEN in .env file');
      console.log('3. Run: npm start');
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

program.parse();
