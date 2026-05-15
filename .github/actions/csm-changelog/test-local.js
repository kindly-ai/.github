#!/usr/bin/env node
// Local test runner for csm-changelog.js — uses `gh` CLI for GitHub API calls (no npm install needed)
// Usage:
//   PR_NUMBER=1234 \
//   ANTHROPIC_API_KEY=sk-ant-... \
//   ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
//   SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
//   REPO_OWNER=kindly-ai \
//   REPO_NAME=kindly \
//   node .github/actions/csm-changelog/test-local.js

const { execSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Load .env from the same directory if present
try {
  const envPath = resolve(__dirname, '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !process.env[key]) {
      process.env[key] = rest.join('=').trim();
    }
  }
} catch { /* no .env, that's fine */ }

const owner = process.env.REPO_OWNER || 'kindly-ai';
const repo = process.env.REPO_NAME || 'kindly';

function ghApi(path) {
  const out = execSync(`gh api "${path}"`, { encoding: 'utf8' });
  return { data: JSON.parse(out) };
}

function ghApiList(path) {
  const out = execSync(`gh api --paginate "${path}"`, { encoding: 'utf8' });
  // --paginate outputs concatenated JSON arrays; wrap and flatten
  const arrays = [];
  let depth = 0, start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '[') { if (depth === 0) start = i; depth++; }
    else if (out[i] === ']') { depth--; if (depth === 0) arrays.push(JSON.parse(out.slice(start, i + 1))); }
  }
  return arrays.flat();
}

const github = {
  rest: {
    pulls: {
      get: ({ owner, repo, pull_number }) =>
        ghApi(`/repos/${owner}/${repo}/pulls/${pull_number}`),
      listFiles: ({ owner, repo, pull_number, per_page, page = 1 }) =>
        ghApi(`/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=${per_page}&page=${page}`),
    },
  },
  paginate: (_fn, { owner, repo, pull_number, per_page }) =>
    ghApiList(`/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=${per_page || 100}`),
};

const context = { repo: { owner, repo } };

const core = {
  info: msg => console.log('[info]', msg),
  warning: msg => console.warn('[warn]', msg),
  error: msg => console.error('[error]', msg),
};

const run = require('./csm-changelog.js');

run({ github, context, core })
  .then(() => console.log('\nDone.'))
  .catch(err => { console.error('\nFailed:', err.message); process.exit(1); });
