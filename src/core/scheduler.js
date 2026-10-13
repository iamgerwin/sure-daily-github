import cron from 'node-cron';
import logger from '../utils/logger.js';
import executor from './executor.js';

class Scheduler {
  constructor() {
    this.task = null;
    this.running = false;
    this.executing = false;
    this.executionStartedAt = null;
  }

  // Runs one scheduled execution, skipping the tick if the previous one is
  // still in flight so concurrent runs cannot race on the state files
  async runScheduledTask(config) {
    if (this.executing) {
      logger.warn('Previous execution still in progress, skipping this run', {
        startedAt: new Date(this.executionStartedAt).toISOString()
      });
      return { skipped: true };
    }

    this.executing = true;
    this.executionStartedAt = Date.now();
    logger.info('Scheduled task triggered');
    try {
      const result = await executor.execute(config);
      if (!result?.success) {
        logger.error('Scheduled task failed', { error: result?.error });
      }
      return result;
    } catch (error) {
      logger.error('Scheduled task failed', { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this.executing = false;
      this.executionStartedAt = null;
    }
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

    this.task = cron.schedule(cronExpression, () => this.runScheduledTask(config), {
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
