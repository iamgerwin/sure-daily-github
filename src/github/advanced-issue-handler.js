import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

class AdvancedIssueHandler {
  constructor(token) {
    this.token = token;
    this.client = null;
    this.stateFile = path.join(process.cwd(), 'data', 'issue-state.json');
  }

  async init() {
    try {
      this.client = new Octokit({ auth: this.token });
      const { data: user } = await this.client.users.getAuthenticated();
      return { success: true, user: user.login };
    } catch (error) {
      logger.error('GitHub authentication failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async loadState() {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // Initialize default state
      return {
        lastDailyReset: null,
        repositories: {}
      };
    }
  }

  async saveState(state) {
    try {
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      logger.error('Failed to save state', { error: error.message });
    }
  }

  shouldResetDaily(state, timezone) {
    if (!state.lastDailyReset) return true;
    
    const now = new Date();
    const lastReset = new Date(state.lastDailyReset);
    
    // Check if we've crossed midnight in the specified timezone
    const nowDate = this.getDateInTimezone(now, timezone);
    const lastResetDate = this.getDateInTimezone(lastReset, timezone);
    
    return nowDate !== lastResetDate;
  }

  getDateInTimezone(date, timezone) {
    return new Date(date.toLocaleString('en-US', { timeZone: timezone })).toDateString();
  }

  getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  getRandomElement(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(Math.random() * array.length)];
  }

  generateIssueContent(repo, config) {
    const randomization = config.randomization || {};
    const templates = config.contentTemplates || [];
    
    // Pick a random template or use default
    const template = templates.length > 0 ? this.getRandomElement(templates) : {};
    const timestamp = new Date().toISOString();
    const now = new Date();
    
    // Replace placeholders
    const replacements = {
      repo: repo.repo,
      timestamp,
      randomBugTitle: randomization.bugTitles ? this.getRandomElement(randomization.bugTitles) : 'General bug',
      randomFeatureTitle: randomization.featureTitles ? this.getRandomElement(randomization.featureTitles) : 'General feature',
      randomDocTitle: randomization.docTitles ? this.getRandomElement(randomization.docTitles) : 'General documentation',
      randomPerfTitle: randomization.perfTitles ? this.getRandomElement(randomization.perfTitles) : 'General performance',
      randomBugDescription: 'Issue detected in the system that needs attention',
      randomFeatureDescription: 'New functionality that would improve user experience',
      step1: 'Navigate to the relevant section',
      step2: 'Perform the action',
      step3: 'Observe the result',
      expectedBehavior: 'System should work as intended',
      actualBehavior: 'System behavior differs from expected',
      useCase: 'Improve workflow efficiency',
      proposedSolution: 'Implement the feature as described',
      alternatives: 'Alternative approaches were considered',
      priority: this.getRandomElement(['Low', 'Medium', 'High']),
      section: 'General documentation',
      currentState: 'Current documentation state',
      proposedChanges: 'Proposed documentation improvements',
      reason: 'To improve clarity and usability',
      area: 'System performance',
      currentPerf: 'Current performance metrics',
      targetPerf: 'Target performance goals',
      approach: 'Optimization strategy',
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString()
    };
    
    // Generate title
    let title = template.title || `Automated Issue - ${replacements.date} ${replacements.time}`;
    let body = template.body || `# Automated Issue\n\n**Created:** ${timestamp}\n**Repository:** ${repo.repo}\n\n---\n*Automated issue created by sure-daily-github*`;
    
    // Replace all placeholders
    Object.entries(replacements).forEach(([key, value]) => {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      title = title.replace(regex, value);
      body = body.replace(regex, value);
    });
    
    return {
      title,
      body,
      labels: [...(template.labels || []), ...(repo.labels || [])]
    };
  }

  async processRepositories(repositories, contentTemplate, dryRun, fullConfig) {
    const state = await this.loadState();
    const timezone = fullConfig.general?.timezone || 'UTC';
    
    // Check if we need to reset daily counters
    if (this.shouldResetDaily(state, timezone)) {
      logger.info('Performing daily reset', { timezone });
      state.lastDailyReset = new Date().toISOString();
      state.repositories = {};
    }
    
    const results = [];
    const now = Date.now();
    
    for (const repo of repositories) {
      if (!repo.enabled) {
        results.push({
          success: true,
          skipped: true,
          repo: `${repo.owner}/${repo.repo}`,
          reason: 'Repository disabled'
        });
        continue;
      }
      
      // Initialize repo state if not exists
      if (!state.repositories[repo.repo]) {
        state.repositories[repo.repo] = {
          issuesCreatedToday: 0,
          lastIssueTime: null,
          todayTarget: null,
          nextIssueTime: null
        };
      }
      
      const repoState = state.repositories[repo.repo];
      
      // Determine today's target if not set
      if (repoState.todayTarget === null && repo.dailyTarget) {
        if (typeof repo.dailyTarget === 'object') {
          repoState.todayTarget = this.getRandomInt(repo.dailyTarget.min, repo.dailyTarget.max);
        } else {
          repoState.todayTarget = repo.dailyTarget;
        }
        logger.info(`Set daily target for ${repo.repo}`, { target: repoState.todayTarget });
      }
      
      // Check if we've reached today's target
      if (repoState.issuesCreatedToday >= repoState.todayTarget) {
        results.push({
          success: true,
          skipped: true,
          repo: `${repo.owner}/${repo.repo}`,
          reason: `Daily target reached (${repoState.issuesCreatedToday}/${repoState.todayTarget})`
        });
        continue;
      }
      
      // Check if enough time has passed since last issue
      if (repoState.nextIssueTime && now < repoState.nextIssueTime) {
        const minutesRemaining = Math.round((repoState.nextIssueTime - now) / 60000);
        results.push({
          success: true,
          skipped: true,
          repo: `${repo.owner}/${repo.repo}`,
          reason: `Waiting for interval (${minutesRemaining} minutes remaining)`
        });
        continue;
      }
      
      try {
        // Generate issue content
        const issueContent = this.generateIssueContent(repo, fullConfig);
        
        if (dryRun) {
          logger.info('DRY RUN: Would create issue', {
            repo: `${repo.owner}/${repo.repo}`,
            title: issueContent.title,
            labels: issueContent.labels
          });
          
          // Update state for dry run too
          repoState.issuesCreatedToday++;
          repoState.lastIssueTime = now;
          
          // Calculate next issue time with random interval
          if (repo.intervalMinutes) {
            const intervalMin = repo.intervalMinutes.min || 60;
            const intervalMax = repo.intervalMinutes.max || 180;
            const randomInterval = this.getRandomInt(intervalMin, intervalMax);
            repoState.nextIssueTime = now + (randomInterval * 60 * 1000);
          }
          
          results.push({
            success: true,
            repo: `${repo.owner}/${repo.repo}`,
            dryRun: true,
            issue: issueContent,
            progress: `${repoState.issuesCreatedToday}/${repoState.todayTarget}`
          });
        } else {
          // Create the issue
          const { data: issue } = await this.client.issues.create({
            owner: repo.owner,
            repo: repo.repo,
            title: issueContent.title,
            body: issueContent.body,
            labels: issueContent.labels
          });
          
          logger.info('Issue created', {
            repo: `${repo.owner}/${repo.repo}`,
            number: issue.number,
            title: issue.title
          });
          
          // Update state
          repoState.issuesCreatedToday++;
          repoState.lastIssueTime = now;
          
          // Calculate next issue time with random interval
          if (repo.intervalMinutes) {
            const intervalMin = repo.intervalMinutes.min || 60;
            const intervalMax = repo.intervalMinutes.max || 180;
            const randomInterval = this.getRandomInt(intervalMin, intervalMax);
            repoState.nextIssueTime = now + (randomInterval * 60 * 1000);
            
            logger.info(`Next issue scheduled`, {
              repo: repo.repo,
              inMinutes: randomInterval,
              at: new Date(repoState.nextIssueTime).toLocaleString('en-US', { timeZone: timezone })
            });
          }
          
          results.push({
            success: true,
            repo: `${repo.owner}/${repo.repo}`,
            issue: {
              number: issue.number,
              url: issue.html_url,
              title: issue.title
            },
            progress: `${repoState.issuesCreatedToday}/${repoState.todayTarget}`
          });
        }
      } catch (error) {
        logger.error('Failed to create issue', {
          repo: `${repo.owner}/${repo.repo}`,
          error: error.message
        });
        
        results.push({
          success: false,
          repo: `${repo.owner}/${repo.repo}`,
          error: error.message
        });
      }
    }
    
    // Save updated state
    await this.saveState(state);
    
    return results;
  }

  async getStatus(repositories) {
    const state = await this.loadState();
    const statuses = [];
    
    for (const repo of repositories) {
      const repoState = state.repositories[repo.repo] || {};
      statuses.push({
        repo: `${repo.owner}/${repo.repo}`,
        issuesCreatedToday: repoState.issuesCreatedToday || 0,
        todayTarget: repoState.todayTarget || 'Not set',
        lastIssueTime: repoState.lastIssueTime ? new Date(repoState.lastIssueTime).toISOString() : 'Never',
        nextIssueTime: repoState.nextIssueTime ? new Date(repoState.nextIssueTime).toISOString() : 'Any time'
      });
    }
    
    return {
      lastDailyReset: state.lastDailyReset,
      repositories: statuses
    };
  }
}

export default AdvancedIssueHandler;
