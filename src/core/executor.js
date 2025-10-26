import CommitHandler from '../github/commit-handler.js';
import IssueHandler from '../github/issue-handler.js';
import AdvancedIssueHandler from '../github/advanced-issue-handler.js';
import logger from '../utils/logger.js';
import config from '../config/loader.js';

class Executor {
  async execute(configOverride = null) {
    const cfg = configOverride || config.get();

    logger.info('Starting execution', {
      mode: cfg.general.mode,
      dryRun: cfg.general.dryRun,
      repositories: cfg.repositories.length
    });

    try {
      // Initialize GitHub client
      const token = config.getGitHubToken();
      const mode = cfg.general.mode || 'commit';

      // Choose handler based on mode
      let handler;
      if (mode === 'issue') {
        // Check if we should use advanced issue handler
        const hasAdvancedConfig = cfg.repositories.some(r => 
          r.intervalMinutes || (typeof r.dailyTarget === 'object')
        );
        
        if (hasAdvancedConfig) {
          handler = new AdvancedIssueHandler(token);
          logger.info('Using advanced issue handler with randomization');
        } else {
          handler = new IssueHandler(token);
        }
      } else {
        handler = new CommitHandler(token);
      }

      // Validate authentication
      const authResult = await handler.init();
      if (!authResult.success) {
        throw new Error('GitHub authentication failed');
      }

      logger.info('Authenticated with GitHub', { user: authResult.user, mode });

      // Process repositories
      const results = await handler.processRepositories(
        cfg.repositories,
        cfg.contentTemplate,
        cfg.general.dryRun,
        cfg
      );

      // Log summary
      const successful = results.filter(r => r.success && !r.skipped).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('Execution completed', {
        total: results.length,
        successful,
        skipped,
        failed
      });

      return {
        success: true,
        results,
        summary: { total: results.length, successful, skipped, failed }
      };
    } catch (error) {
      logger.error('Execution failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getStatus() {
    try {
      const cfg = config.get();
      const token = config.getGitHubToken();
      
      // Use advanced handler if available
      const hasAdvancedConfig = cfg.repositories.some(r => 
        r.intervalMinutes || (typeof r.dailyTarget === 'object')
      );
      
      const handler = hasAdvancedConfig 
        ? new AdvancedIssueHandler(token)
        : new CommitHandler(token);

      const status = await handler.getStatus(cfg.repositories);
      return { success: true, status };
    } catch (error) {
      logger.error('Failed to get status', { error: error.message });
      return { success: false, error: error.message };
    }
  }
}

export default new Executor();
