import cron from 'node-cron';
import logger from '../utils/logger.js';
import executor from './executor.js';

class Scheduler {
  constructor() {
    this.task = null;
    this.running = false;
  }

  start(config) {
    if (!config.schedule?.enabled) {
      logger.info('Scheduler is disabled in configuration');
      return false;
    }

    if (this.running) {
      logger.warn('Scheduler is already running');
      return false;
    }

    const cronExpression = config.schedule.cron;

    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      logger.error('Invalid cron expression', { cron: cronExpression });
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    this.task = cron.schedule(cronExpression, async () => {
      logger.info('Scheduled task triggered');
      try {
        await executor.execute(config);
      } catch (error) {
        logger.error('Scheduled task failed', { error: error.message });
      }
    }, {
      timezone: config.schedule.timezone || config.general.timezone || 'UTC'
    });

    this.running = true;
    logger.info('Scheduler started', {
      cron: cronExpression,
      timezone: config.schedule.timezone || config.general.timezone || 'UTC'
    });

    return true;
  }

  stop() {
    if (!this.running || !this.task) {
      logger.warn('Scheduler is not running');
      return false;
    }

    this.task.stop();
    this.task = null;
    this.running = false;
    logger.info('Scheduler stopped');
    return true;
  }

  isRunning() {
    return this.running;
  }
}

export default new Scheduler();
