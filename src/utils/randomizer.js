import crypto from 'crypto';
import logger from './logger.js';
import state from './state.js';

class Randomizer {
  /**
   * Generate a random integer between min and max (inclusive)
   * Uses crypto.randomInt for better distribution
   */
  randomInt(min, max) {
    if (min > max) {
      throw new Error('min cannot be greater than max');
    }
    if (min === max) {
      return min;
    }
    return crypto.randomInt(min, max + 1);
  }

  /**
   * Calculate random count based on dailyTarget config
   */
  getRandomCount(targetConfig) {
    if (!targetConfig || typeof targetConfig !== 'object') {
      return 1;
    }

    const { min, max } = targetConfig;
    if (min === undefined || max === undefined) {
      return 1;
    }

    return this.randomInt(min, max);
  }

  /**
   * Get random count with time-based variations
   */
  getRandomCountWithTimeVariation(randomizationConfig, period = 'daily') {
    if (!randomizationConfig?.enabled) {
      return null;
    }

    const timeVariations = randomizationConfig.timeVariations;
    if (!timeVariations?.enabled) {
      // Use base issue count if no time variations
      return this.getRandomCount(randomizationConfig.issueCount);
    }

    // Select appropriate time period
    let targetRange;
    switch (period) {
      case 'hourly':
        targetRange = timeVariations.hourly;
        break;
      case 'weekly':
        targetRange = timeVariations.weekly;
        break;
      case 'daily':
      default:
        // Without its own daily range, fall back to issueCount like the daily
        // cap in issue-handler checkLimits, instead of one issue per run
        targetRange = timeVariations.daily ?? randomizationConfig.issueCount;
        break;
    }

    const count = this.getRandomCount(targetRange);
    logger.debug('Generated random count with time variation', {
      period,
      range: targetRange,
      count
    });

    return count;
  }

  /**
   * Shuffle array using Fisher-Yates algorithm
   */
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Select repositories based on strategy. A dry run previews the round-robin
   * pick without moving the persisted cursor, so the next real run is unchanged.
   * `rotation` is the full configured repository list the round-robin cursor
   * walks; `repositories` may be a subset of it (those that can act this run).
   */
  selectRepositories(repositories, selectionConfig, cursorStore = state, { dryRun = false, rotation = null } = {}) {
    if (!repositories || repositories.length === 0) {
      return [];
    }

    const enabledRepos = repositories.filter(repo => repo.enabled);
    if (enabledRepos.length === 0) {
      return [];
    }

    const strategy = selectionConfig?.strategy || 'sequential';
    const maxPerExecution = selectionConfig?.maxPerExecution;
    const randomizeOrder = selectionConfig?.randomizeOrder || false;

    let selectedRepos;

    switch (strategy) {
      case 'random':
        selectedRepos = this.selectRandomRepositories(enabledRepos, maxPerExecution);
        break;

      case 'weighted':
        selectedRepos = this.selectWeightedRepositories(enabledRepos, maxPerExecution);
        break;

      case 'round-robin': {
        const { selected, nextIndex } = this.selectFromRotation(
          enabledRepos, rotation, maxPerExecution, cursorStore.getRoundRobinIndex()
        );
        selectedRepos = selected;
        if (!dryRun) {
          cursorStore.setRoundRobinIndex(nextIndex);
        }
        break;
      }

      case 'sequential':
      default:
        selectedRepos = enabledRepos;
        if (randomizeOrder) {
          selectedRepos = this.shuffleArray(selectedRepos);
        }
        if (maxPerExecution && maxPerExecution < selectedRepos.length) {
          selectedRepos = selectedRepos.slice(0, maxPerExecution);
        }
        break;
    }

    logger.debug('Selected repositories', {
      strategy,
      total: repositories.length,
      enabled: enabledRepos.length,
      selected: selectedRepos.length
    });

    return selectedRepos;
  }

  /**
   * Select random repositories
   */
  selectRandomRepositories(repositories, maxCount) {
    const shuffled = this.shuffleArray(repositories);
    if (maxCount && maxCount < shuffled.length) {
      return shuffled.slice(0, maxCount);
    }
    return shuffled;
  }

  /**
   * Select repositories using weighted random selection
   */
  selectWeightedRepositories(repositories, maxCount) {
    const selected = [];
    const count = maxCount && maxCount < repositories.length
      ? maxCount
      : repositories.length;

    // Calculate total weight
    const totalWeight = repositories.reduce((sum, repo) => sum + (repo.weight || 1), 0);

    // Make a pool of repositories (can be selected multiple times if maxCount > repos.length)
    const pool = [...repositories];

    for (let i = 0; i < count && pool.length > 0; i++) {
      // Weighted random selection
      const currentTotalWeight = pool.reduce((sum, repo) => sum + (repo.weight || 1), 0);
      let random = Math.random() * currentTotalWeight;

      // Floating-point rounding can leave a tiny remainder after subtracting
      // every weight; that draw belongs to the last repo, not the first
      let selectedIndex = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        random -= (pool[j].weight || 1);
        if (random <= 0) {
          selectedIndex = j;
          break;
        }
      }

      selected.push(pool[selectedIndex]);
      pool.splice(selectedIndex, 1); // Remove to avoid duplicates in same execution
    }

    return selected;
  }

  /**
   * Round-robin over the configured rotation, picking only the candidates.
   * The cursor is a position in the rotation, not in the candidate list: a
   * candidate list that shrinks (a repo met its target or waits for its
   * interval) would otherwise shift every position and skip the next repo.
   * Returns the picks in rotation order and the cursor for the next run.
   */
  selectFromRotation(candidates, rotation, maxCount, cursor = 0) {
    const eligible = new Set(candidates);
    const order = (rotation || []).filter(repo => eligible.has(repo));
    // Without a rotation that covers every candidate, rotate the candidates alone
    const ring = order.length === candidates.length ? (rotation || []).filter(repo => repo.enabled !== false) : candidates;
    const count = maxCount && maxCount < candidates.length ? maxCount : candidates.length;
    const start = cursor % ring.length;

    const selected = [];
    let lastPosition = start - 1;
    for (let i = 0; i < ring.length && selected.length < count; i++) {
      const position = (start + i) % ring.length;
      if (eligible.has(ring[position])) {
        selected.push(ring[position]);
        lastPosition = position;
      }
    }

    return { selected, nextIndex: (lastPosition + 1) % ring.length };
  }

  /**
   * Select repositories in round-robin fashion
   * Starting at currentIndex, each repository is picked at most once per call
   */
  selectRoundRobinRepositories(repositories, maxCount, currentIndex = 0) {
    if (!repositories || repositories.length === 0) {
      return [];
    }

    const selected = [];
    const count = maxCount && maxCount < repositories.length
      ? maxCount
      : repositories.length;

    for (let i = 0; i < count; i++) {
      const index = (currentIndex + i) % repositories.length;
      selected.push(repositories[index]);
    }

    return selected;
  }
}

export default new Randomizer();
