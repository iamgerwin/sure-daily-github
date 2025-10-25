import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config();

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
        if (!repo.owner) errors.push(`Repository ${idx}: owner is required`);
        if (!repo.repo) errors.push(`Repository ${idx}: repo is required`);
        if (repo.owner && !/^[a-zA-Z0-9-]+$/.test(repo.owner)) {
          errors.push(`Repository ${idx}: invalid owner format`);
        }
        if (repo.repo && !/^[a-zA-Z0-9._-]+$/.test(repo.repo)) {
          errors.push(`Repository ${idx}: invalid repo format`);
        }
      });
    }

    // Validate general settings
    const general = config.general || {};

    // Validate dailyTarget (can be number or range object)
    if (general.dailyTarget) {
      if (typeof general.dailyTarget === 'number') {
        if (general.dailyTarget < 1 || general.dailyTarget > 100) {
          errors.push('dailyTarget must be between 1 and 100');
        }
      } else if (typeof general.dailyTarget === 'object') {
        if (!general.dailyTarget.min || !general.dailyTarget.max) {
          errors.push('dailyTarget range must have min and max values');
        }
        if (general.dailyTarget.min < 1 || general.dailyTarget.max > 100) {
          errors.push('dailyTarget range must be between 1 and 100');
        }
        if (general.dailyTarget.min > general.dailyTarget.max) {
          errors.push('dailyTarget min cannot be greater than max');
        }
      }
    }

    // Validate randomization settings
    if (config.randomization?.enabled) {
      const rand = config.randomization;
      if (rand.issueCount) {
        if (!rand.issueCount.min || !rand.issueCount.max) {
          errors.push('randomization.issueCount must have min and max values');
        }
        if (rand.issueCount.min > rand.issueCount.max) {
          errors.push('randomization.issueCount min cannot be greater than max');
        }
      }
    }

    // Validate repository selection
    if (config.repositorySelection) {
      const validStrategies = ['random', 'weighted', 'round-robin', 'sequential'];
      if (config.repositorySelection.strategy && !validStrategies.includes(config.repositorySelection.strategy)) {
        errors.push(`repositorySelection.strategy must be one of: ${validStrategies.join(', ')}`);
      }
    }

    // Validate schedule
    if (config.schedule?.enabled && !config.schedule.cron) {
      errors.push('Cron expression is required when schedule is enabled');
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
          branch: repo.branch || 'main',
          dailyTarget: normalizeDailyTarget(repoTarget),
          path: repo.path || 'daily-updates',
          commitMessage: repo.commitMessage || 'docs: daily update ${date}',
          labels: repo.labels || ['automated'],
          weight: repo.weight || 1
        };
      }),
      contentTemplate: config.contentTemplate || {
        title: 'Daily Update',
        body: 'Progress update for ${date}'
      }
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
