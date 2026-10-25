import cron from 'node-cron';
import logger from '../utils/logger.js';
import executor from './executor.js';
import babysitter from './babysitter.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

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
      if (result?.locked) {
        logger.warn('Another process holds the run lock, skipped this run', { error: result.error });
      } else if (!result?.success) {
        logger.error('Scheduled task failed', { error: result?.error });
      }
      await this.runScheduledBabysit(config);
      return result;
    } catch (error) {
      logger.error('Scheduled task failed', { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this.executing = false;
      this.executionStartedAt = null;
    }
  }

  // Opt-in babysit scan on the same cadence. Runs after the execution has
  // released the run lock, and its failures never affect the execution result.
  async runScheduledBabysit(config) {
    if (!config.babysit?.enabled) return null;
    try {
      const result = await babysitter.execute(config);
      if (result?.locked) {
        logger.warn('Another process holds the run lock, skipped babysit scan', { error: result.error });
      } else if (!result?.success || result.summary?.failed > 0) {
        logger.error('Scheduled babysit scan had failures', { error: result?.error, summary: result?.summary });
      }
      return result;
    } catch (error) {
      logger.error('Scheduled babysit scan failed', { error: error.message });
      return { success: false, error: error.message };
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

  // Ctrl+C or a service stop (SIGTERM from systemd or pm2). A babysit scan in
  // flight has its own handlers that kill its detached engine and test process
  // groups, clean up and exit; exiting here first would orphan them.
  handleShutdown(signal, { exit = (code) => process.exit(code) } = {}) {
    if (this.running) {
      logger.info('Stopping scheduler', { signal });
      this.stop();
    }
    if (babysitter.isRunning()) {
      logger.info('Waiting for the babysit scan to stop', { signal });
      return false;
    }
    exit(0);
    return true;
  }

  installSignalHandlers(options) {
    const handlers = SHUTDOWN_SIGNALS.map(signal => [signal, () => this.handleShutdown(signal, options)]);
    handlers.forEach(([signal, handler]) => process.on(signal, handler));
    return () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
  }
}

export default new Scheduler();
