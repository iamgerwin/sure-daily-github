#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import executor, { describeFailures, getRunExitCode } from './core/executor.js';
import scheduler from './core/scheduler.js';
import ConflictFixer, { parseScanTimeout } from './core/conflict-fixer.js';
import babysitter, { getBabysitExitCode } from './core/babysitter.js';
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

        const failures = describeFailures(result.results);
        if (failures.length > 0) {
          console.error('❌ Failed repositories:');
          failures.forEach(line => console.error(`   ${line}`));
          console.error('');
        }
        process.exit(getRunExitCode(result));
      } else {
        console.error('❌ Execution failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

// Babysit command - address review comments on labeled pull requests
const collect = (value, previous) => previous.concat([value]);

program
  .command('babysit')
  .description('Address review comments on pull requests labeled for babysitting (never merges)')
  .option('--once', 'Run a single scan and exit (default)')
  .option('--repo <owner/repo>', 'Restrict to a configured repository (repeatable)', collect, [])
  .option('--pr <number>', 'Restrict to one pull request (requires exactly one --repo)')
  .option('--dry-run', 'Triage and print planned actions without pushing, replying, or recording')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      let pr = null;
      if (options.pr !== undefined) {
        pr = Number(options.pr);
        if (!/^\d+$/.test(options.pr) || pr < 1) {
          throw new Error('--pr must be a positive pull request number');
        }
        if (options.repo.length !== 1) {
          throw new Error('--pr requires exactly one --repo <owner/repo>');
        }
      }
      const invalidRepo = options.repo.find(name => !/^[^/\s]+\/[^/\s]+$/.test(name));
      if (invalidRepo) {
        throw new Error(`--repo must be owner/repo, got "${invalidRepo}"`);
      }

      const cfg = config.load(options.config);
      const result = await babysitter.execute(cfg, { repos: options.repo, pr, dryRun: Boolean(options.dryRun) });

      if (result.locked) {
        console.log(`\n⏭️  ${result.error}; skipped this scan\n`);
        process.exit(0);
      }
      if (!result.success) {
        console.error('❌ Babysit failed:', result.error);
        process.exit(1);
      }

      console.log(`\n✅ Babysit scan completed${result.dryRun ? ' (dry run)' : ''}\n`);
      for (const r of result.results) {
        const name = `${r.owner}/${r.repo}${r.number !== undefined ? `#${r.number}` : ''}`;
        if (r.error) {
          console.error(`❌ ${name}: ${r.error}`);
        } else if (r.skipped) {
          console.log(`⏭️  ${name}: ${r.reason}`);
        } else if (r.planned) {
          console.log(`📝 ${name}: ${r.planned.length} planned action(s)`);
          r.planned.forEach(p => console.log(`   ${p.action.padEnd(7)} ${p.id} by ${p.author}: ${p.reasoning}`));
          (r.undecided || []).forEach(id => console.log(`   ???     ${id}: no triage decision`));
        } else {
          const c = r.counts;
          console.log(`🔧 ${name}: addressed ${c.addressed}, deferred ${c.deferred}, wontfix ${c.wontfix}, noted ${c.noted}, failed ${c.failed}${r.commitSha ? ` (pushed ${r.commitSha.slice(0, 12)})` : ''}`);
          (r.failures || []).forEach(f => console.error(`   ❌ ${f.id}: ${f.error}`));
        }
      }

      const s = result.summary;
      console.log(`\nPull requests: ${s.prs} (skipped ${s.skipped})`);
      console.log(`Comments:      addressed ${s.addressed}, deferred ${s.deferred}, wontfix ${s.wontfix}, noted ${s.noted}`);
      console.log(`Failed:        ${s.failed}\n`);
      process.exit(getBabysitExitCode(result));
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

// Fix-conflicts command - merge the base branch into conflicted open PRs
program
  .command('fix-conflicts')
  .description('Resolve merge conflicts on open pull requests (newer change wins, pushed only if tests pass)')
  .option('--dry-run', 'Resolve and test locally without pushing')
  .option('--scan-only', 'Only list conflicted pull requests')
  .option('--repo <owner/repo>', 'Only process this configured repository (repeatable)', (value, list) => [...list, value], [])
  .option('--pr <number>', 'Only process this pull request (requires one --repo)')
  .option('--scan-timeout <seconds>', 'Time budget for listing pull requests (overrides conflictFixer.scanTimeoutSeconds)')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      const scanTimeoutSeconds = options.scanTimeout === undefined ? null : parseScanTimeout(options.scanTimeout);
      const cfg = config.load(options.config);
      const fixer = new ConflictFixer(config.getGitHubToken());
      const result = await fixer.run(cfg, {
        repos: options.repo,
        pr: options.pr ?? null,
        dryRun: Boolean(options.dryRun),
        scanOnly: Boolean(options.scanOnly),
        scanTimeoutSeconds
      });

      if (!result.success) {
        console.error('❌ Conflict fixer failed:', result.error);
        process.exit(1);
      }

      if (result.results.length === 0) {
        console.log('\n✅ No conflicted pull requests found\n');
      } else {
        console.log('\n🔧 Conflicted Pull Requests\n');
        result.results.forEach(r => {
          const target = `${r.owner}/${r.repo}${r.pr ? `#${r.pr}` : ''}`.padEnd(36);
          console.log(`${target} ${r.status.padEnd(20)} ${r.reason || r.error || ''}`);
          if (r.output) {
            console.log(r.output.split('\n').map(line => `    ${line}`).join('\n'));
          }
        });
      }

      console.log(`\nFixed:               ${result.summary.fixed}`);
      console.log(`Needs manual review: ${result.summary.needsManualReview}`);
      console.log(`Skipped:             ${result.summary.skipped}`);
      console.log(`Scan timeout:        ${result.summary.scanTimeout}`);
      console.log(`Failed:              ${result.summary.failed}\n`);
      process.exit(getRunExitCode(result));
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
      console.log(`   Babysit: ${cfg.babysit.enabled ? 'enabled' : 'disabled'} (label "${cfg.babysit.label}", ${cfg.babysit.engine} ${cfg.babysit.model})`);

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
