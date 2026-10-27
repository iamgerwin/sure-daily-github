#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import executor, { describeFailures, getRunExitCode } from './core/executor.js';
import scheduler from './core/scheduler.js';
import ConflictFixer, { parseScanTimeout } from './core/conflict-fixer.js';
import babysitter, { getBabysitExitCode } from './core/babysitter.js';
import prMaint, { getPrMaintExitCode } from './core/pr-maint.js';
import config, { PR_MAINT_MODES, defaultConfigPath } from './config/loader.js';
import { getTemplateDateParts } from './utils/template-date.js';

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

// PR-maint command - one tick of the pull request lifecycle orchestrator
program
  .command('pr-maint')
  .description('Label, track, and report open pull requests through the policy engine (never merges)')
  .option('--mode <mode>', `Override prMaint.mode (${PR_MAINT_MODES.join(', ')})`)
  .option('--once', 'Run a single tick and exit (default)')
  .option('--repo <owner/repo>', 'Restrict to a configured repository (repeatable)', collect, [])
  .option('--pr <number>', 'Restrict actions to one pull request (requires exactly one --repo)')
  .option('--dry-run', 'Decide and print planned actions without writing to GitHub or the state files')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      if (options.mode !== undefined && !PR_MAINT_MODES.includes(options.mode)) {
        throw new Error(`--mode must be one of: ${PR_MAINT_MODES.join(', ')}`);
      }
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
      const result = await prMaint.execute(cfg, {
        repos: options.repo,
        pr,
        mode: options.mode ?? null,
        dryRun: Boolean(options.dryRun)
      });

      if (result.locked) {
        console.log(`\n⏭️  ${result.error}; skipped this tick\n`);
        process.exit(0);
      }
      if (result.skipped) {
        console.log(`\n⏭️  pr-maint skipped: ${result.reason}\n`);
        process.exit(0);
      }
      if (!result.success) {
        console.error('❌ pr-maint failed:', result.error);
        process.exit(1);
      }

      const modeNote = result.mode !== result.configuredMode ? ` (configured ${result.configuredMode}, breaker tripped)` : '';
      console.log(`\n✅ pr-maint tick completed in ${result.mode} mode${modeNote}${result.dryRun ? ' (dry run)' : ''}\n`);
      for (const r of result.results) {
        const name = `${r.owner}/${r.repo}`;
        if (r.error) {
          console.error(`❌ ${name}: ${r.error}`);
          continue;
        }
        if (r.skipped || r.paused) {
          console.log(`⏭️  ${name}: ${r.paused ? 'paused by the dashboard issue' : r.reason}`);
          continue;
        }
        console.log(`📋 ${name} (dashboard ${r.dashboard})`);
        for (const p of r.prs) {
          const state = p.skip ? `skipped (${p.skip})` : (p.lifecycle || 'none');
          const notes = [p.priority, p.changed ? null : 'unchanged'].filter(Boolean).join(', ');
          console.log(`   #${String(p.number).padEnd(5)} ${state}${notes ? ` [${notes}]` : ''}`);
          if (!p.outcomes.length && p.pending.length) console.log(`      pending  ${p.pending.join('; ')}`);
          p.outcomes.forEach(o => console.log(`      ${o.status.padEnd(8)} ${o.detail}${o.rule ? ` (${o.rule}: ${o.reason})` : ''}`));
        }
      }

      const s = result.summary;
      console.log(`\nPull requests: ${s.prs}`);
      console.log(`Actions:       ${s.actions} (written ${s.written}, denied ${s.denied})`);
      console.log(`Failed:        ${s.failed}\n`);
      process.exit(getPrMaintExitCode(result));
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

      // Keep process alive; SIGINT and SIGTERM stop it
      scheduler.installSignalHandlers();
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
          // Show times in general.timezone, the same clock the daily reset uses
          const timezone = result.status.timezone || 'UTC';
          console.log('┌─────────────────────────────────┬────────────┬───────┬──────────────────────┐');
          console.log('│ Repository                      │ Target     │ Today │ Next Issue           │');
          console.log('├─────────────────────────────────┼────────────┼───────┼──────────────────────┤');

          result.status.repositories.forEach(repo => {
            const repoName = repo.repo.padEnd(31);
            const target = (repo.todayTarget || 'N/A').toString().padStart(10);
            const today = (repo.issuesCreatedToday || 0).toString().padStart(5);
            let nextIssue = 'Any time';
            
            if (repo.nextIssueTime && repo.nextIssueTime !== 'Any time') {
              nextIssue = getTemplateDateParts(timezone, new Date(repo.nextIssueTime)).time.slice(0, 5);
            }
            
            nextIssue = nextIssue.padStart(20);

            console.log(`│ ${repoName} │ ${target} │ ${today} │ ${nextIssue} │`);
          });

          console.log('└─────────────────────────────────┴────────────┴───────┴──────────────────────┘\n');
          
          if (result.status.lastDailyReset) {
            const { date, time } = getTemplateDateParts(timezone, new Date(result.status.lastDailyReset));
            console.log(`Last daily reset: ${date} ${time} (${timezone})\n`);
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

        if (result.disabled?.length) {
          console.log(`Disabled (skipped by run): ${result.disabled.join(', ')}\n`);
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
      console.log(`   PR maintenance: ${cfg.prMaint.enabled ? 'enabled' : 'disabled'} (${cfg.prMaint.mode} mode, authors ${cfg.prMaint.authors.join(', ')})`);

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
  .option('--config <path>', 'Where to write the configuration file')
  .action(async (options) => {
    try {
      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      // The path every other command reads without --config, not one relative
      // to the working directory, so a global `sure-daily-github init` is found
      const configPath = options.config || defaultConfigPath();

      if (existsSync(configPath)) {
        console.log('⚠️  Configuration file already exists:', configPath);
        process.exit(1);
      }

      mkdirSync(dirname(configPath), { recursive: true });

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
    commitMessage: "docs: daily update \${date}"

contentTemplate:
  # Variables: \${date}, \${time} (in general.timezone), \${timestamp} (UTC ISO)
  title: "Daily Update"
  body: "Automated update for \${date} at \${timestamp}"
`;

      writeFileSync(configPath, exampleConfig);
      const configFlag = options.config ? ` --config ${options.config}` : '';
      console.log('✅ Configuration file created:', configPath);
      console.log('\nNext steps:');
      console.log(`1. Edit ${configPath} with your settings`);
      console.log('2. Set GITHUB_TOKEN in .env file');
      console.log(`3. Try it: node src/cli.js run --dry-run${configFlag}`);
      console.log('4. To run on a schedule, set schedule.enabled: true, then: npm start');
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

program.parse();
