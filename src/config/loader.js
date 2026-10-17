import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config();

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const isTargetCount = (value) => Number.isInteger(value) && value >= 1 && value <= 100;

// Accepts a whole number or a { min, max } range, each value within 1-100
function validateDailyTarget(target, label, errors) {
  if (typeof target === 'number') {
    if (!isTargetCount(target)) {
      errors.push(`${label} must be a whole number between 1 and 100`);
    }
  } else if (target && typeof target === 'object' && !Array.isArray(target)) {
    if (target.min === undefined || target.min === null || target.max === undefined || target.max === null) {
      errors.push(`${label} range must have min and max values`);
    } else if (!isTargetCount(target.min) || !isTargetCount(target.max)) {
      errors.push(`${label} range must be whole numbers between 1 and 100`);
    } else if (target.min > target.max) {
      errors.push(`${label} min cannot be greater than max`);
    }
  } else {
    errors.push(`${label} must be a number or a { min, max } range`);
  }
}

// A { min, max } range of positive whole numbers, with no upper bound
function validateCountRange(range, label, errors) {
  if (!range || typeof range !== 'object' || Array.isArray(range)
    || range.min === undefined || range.min === null || range.max === undefined || range.max === null) {
    errors.push(`${label} must have min and max values`);
  } else if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1 || range.max < 1) {
    errors.push(`${label} must be positive whole numbers`);
  } else if (range.min > range.max) {
    errors.push(`${label} min cannot be greater than max`);
  }
}

class ConfigLoader {
  constructor() {
    this.config = null;
  }

  load(configPath = null) {
    // Determine config file path
    const filePath = configPath
      || process.env.CONFIG_PATH
      || path.join(__dirname, '../../config/config.yaml');

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Configuration file not found: ${filePath}`);
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const rawConfig = yaml.load(fileContent);

      // Validate and process configuration
      this.config = this.validate(rawConfig);

      logger.info('Configuration loaded successfully', {
        repos: this.config.repositories.length,
        schedule: this.config.schedule?.enabled
      });

      return this.config;
    } catch (error) {
      logger.error('Failed to load configuration', { error: error.message });
      throw error;
    }
  }

  validate(config) {
    // An empty file parses to undefined and a top-level list or scalar has no
    // keys, so fail with a readable message instead of a TypeError below
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Configuration validation failed:\nConfiguration file must contain a YAML mapping (e.g. "repositories:")');
    }

    const errors = [];

    // Validate GitHub token
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      errors.push('GITHUB_TOKEN environment variable is required');
    } else if (!token.startsWith('ghp_') && !token.startsWith('github_pat_') && !token.startsWith('gho_')) {
      errors.push('GITHUB_TOKEN appears to be invalid format (must start with ghp_, gho_, or github_pat_)');
    }

    // Validate repositories
    if (!config.repositories || !Array.isArray(config.repositories)) {
      errors.push('Configuration must include a repositories array');
    } else if (config.repositories.length === 0) {
      errors.push('At least one repository must be configured');
    } else {
      config.repositories.forEach((repo, idx) => {
        // A bare "-" list item parses to null and would crash the checks below
        if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
          errors.push(`Repository ${idx}: must be a mapping with owner and repo`);
          return;
        }
        if (!repo.owner) errors.push(`Repository ${idx}: owner is required`);
        if (!repo.repo) errors.push(`Repository ${idx}: repo is required`);
        if (repo.owner && !/^[a-zA-Z0-9-]+$/.test(repo.owner)) {
          errors.push(`Repository ${idx}: invalid owner format`);
        }
        if (repo.repo && !/^[a-zA-Z0-9._-]+$/.test(repo.repo)) {
          errors.push(`Repository ${idx}: invalid repo format`);
        }
        if (repo.intervalMinutes !== undefined && repo.intervalMinutes !== null) {
          const { min, max } = repo.intervalMinutes;
          if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < 1) {
            errors.push(`Repository ${idx}: intervalMinutes must have positive numeric min and max`);
          } else if (min > max) {
            errors.push(`Repository ${idx}: intervalMinutes min cannot be greater than max`);
          }
        }
        // An invalid per-repo range would otherwise crash the run in randomInt
        // or be silently replaced with a target of 1
        if (repo.dailyTarget !== undefined && repo.dailyTarget !== null) {
          validateDailyTarget(repo.dailyTarget, `Repository ${idx}: dailyTarget`, errors);
        }
        // A zero or negative weight skews weighted selection toward the first repo
        if (repo.weight !== undefined && repo.weight !== null
          && (typeof repo.weight !== 'number' || !Number.isFinite(repo.weight) || repo.weight <= 0)) {
          errors.push(`Repository ${idx}: weight must be a positive number`);
        }
      });
    }

    if (config.contentTemplates !== undefined && !Array.isArray(config.contentTemplates)) {
      errors.push('contentTemplates must be an array');
    }

    // Validate general settings
    const general = config.general || {};

    // An unknown mode would otherwise silently fall back to commit mode
    const validModes = ['commit', 'issue'];
    if (general.mode && !validModes.includes(general.mode)) {
      errors.push(`general.mode must be one of: ${validModes.join(', ')}`);
    }

    // An invalid timezone would otherwise make every run throw a RangeError
    if (general.timezone && !isValidTimezone(general.timezone)) {
      errors.push(`general.timezone is not a valid IANA timezone: ${general.timezone}`);
    }
    if (config.schedule?.timezone && !isValidTimezone(config.schedule.timezone)) {
      errors.push(`schedule.timezone is not a valid IANA timezone: ${config.schedule.timezone}`);
    }

    // Validate dailyTarget (can be number or range object)
    if (general.dailyTarget !== undefined && general.dailyTarget !== null) {
      validateDailyTarget(general.dailyTarget, 'dailyTarget', errors);
    }

    // Validate randomization settings; a fractional or inverted range would
    // otherwise throw from randomInt partway through an issue-mode run
    if (config.randomization?.enabled) {
      const rand = config.randomization;
      if (rand.issueCount) {
        validateCountRange(rand.issueCount, 'randomization.issueCount', errors);
      }
      const timeVar = rand.timeVariations;
      if (timeVar?.enabled) {
        for (const period of ['hourly', 'daily', 'weekly']) {
          if (timeVar[period] !== undefined && timeVar[period] !== null) {
            validateCountRange(timeVar[period], `randomization.timeVariations.${period}`, errors);
          }
        }
      }
    }

    // Validate repository selection
    if (config.repositorySelection) {
      const validStrategies = ['random', 'weighted', 'round-robin', 'sequential'];
      if (config.repositorySelection.strategy && !validStrategies.includes(config.repositorySelection.strategy)) {
        errors.push(`repositorySelection.strategy must be one of: ${validStrategies.join(', ')}`);
      }
      // A non-positive cap would otherwise drop repos (slice(0, -1)) or select none
      const { maxPerExecution } = config.repositorySelection;
      if (maxPerExecution !== undefined && maxPerExecution !== null
        && (!Number.isInteger(maxPerExecution) || maxPerExecution < 1)) {
        errors.push('repositorySelection.maxPerExecution must be a positive whole number or null');
      }
    }

    // Validate schedule
    if (config.schedule?.enabled && !config.schedule.cron) {
      errors.push('Cron expression is required when schedule is enabled');
    } else if (config.schedule?.enabled && !cron.validate(config.schedule.cron)) {
      // Otherwise `validate` passes and the scheduler only throws once `start` runs
      errors.push(`schedule.cron is not a valid cron expression: ${config.schedule.cron}`);
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    // Normalize dailyTarget to consistent format
    const normalizeDailyTarget = (target) => {
      if (typeof target === 'number') {
        return { min: target, max: target };
      } else if (typeof target === 'object' && target.min && target.max) {
        return { min: target.min, max: target.max };
      }
      return { min: 1, max: 1 };
    };

    const generalTarget = general.dailyTarget || 1;
    const normalizedGeneralTarget = normalizeDailyTarget(generalTarget);

    // Set defaults
    return {
      general: {
        timezone: general.timezone || 'UTC',
        dailyTarget: normalizedGeneralTarget,
        mode: general.mode || 'commit',
        dryRun: general.dryRun || false
      },
      randomization: config.randomization || {
        enabled: false,
        issueCount: normalizedGeneralTarget,
        timeVariations: {
          enabled: false,
          hourly: { min: 1, max: 3 },
          daily: { min: 5, max: 15 },
          weekly: { min: 20, max: 50 }
        }
      },
      repositorySelection: config.repositorySelection || {
        strategy: 'sequential',
        randomizeOrder: false,
        maxPerExecution: null
      },
      schedule: config.schedule || { enabled: false },
      repositories: config.repositories.map(repo => {
        const repoTarget = repo.dailyTarget || generalTarget;
        return {
          owner: repo.owner,
          repo: repo.repo,
          enabled: repo.enabled !== false,
          // Unset means the repository's default branch, resolved by GitHub
          branch: repo.branch || null,
          dailyTarget: normalizeDailyTarget(repoTarget),
          path: repo.path || 'daily-updates',
          commitMessage: repo.commitMessage || 'docs: daily update ${date}',
          labels: repo.labels || ['automated'],
          weight: repo.weight || 1,
          // Consumed by AdvancedIssueHandler to space issues out across the day
          intervalMinutes: repo.intervalMinutes || null
        };
      }),
      contentTemplate: config.contentTemplate || {
        title: 'Daily Update',
        body: 'Progress update for ${date}'
      },
      // Randomly picked per issue by AdvancedIssueHandler
      contentTemplates: config.contentTemplates || []
    };
  }

  get() {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  getGitHubToken() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable not set');
    }
    return token;
  }
}

export default new ConfigLoader();
