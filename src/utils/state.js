import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '../../data/state.json');

class StateManager {
  constructor() {
    this.state = this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading state:', error.message);
    }
    return { repositories: {} };
  }

  save() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error('Error saving state:', error.message);
    }
  }

  getRepoState(owner, repo) {
    const key = `${owner}/${repo}`;
    if (!this.state.repositories[key]) {
      this.state.repositories[key] = {
        lastCommitDate: null,
        commitsToday: 0,
        totalCommits: 0
      };
    }
    return this.state.repositories[key];
  }

  updateRepoState(owner, repo, updates) {
    const key = `${owner}/${repo}`;
    const repoState = this.getRepoState(owner, repo);
    Object.assign(repoState, updates);
    this.save();
  }

  isCommitNeeded(owner, repo, targetCount = 1) {
    const repoState = this.getRepoState(owner, repo);
    const today = new Date().toISOString().split('T')[0];

    // Reset counter if it's a new day
    if (repoState.lastCommitDate !== today) {
      repoState.commitsToday = 0;
      repoState.lastCommitDate = today;
      this.save();
    }

    return repoState.commitsToday < targetCount;
  }

  recordCommit(owner, repo) {
    const repoState = this.getRepoState(owner, repo);
    const today = new Date().toISOString().split('T')[0];

    repoState.commitsToday = (repoState.lastCommitDate === today)
      ? repoState.commitsToday + 1
      : 1;
    repoState.lastCommitDate = today;
    repoState.totalCommits++;

    this.save();
  }
}

export default new StateManager();
