module.exports = async function runCsmChangelogRelease({ github, context, core }) {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackChannelId = process.env.SLACK_CHANNEL_ID;
  const lookbackDays = Number(process.env.LOOKBACK_DAYS || 30);
  const { owner, repo } = context.repo;

  for (const name of ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const tagName = process.env.RELEASE_TAG || context.payload.release?.tag_name;
  if (!tagName) {
    throw new Error('No release tag found. Run on a "release" event or pass RELEASE_TAG.');
  }

  async function slackApi(method, params) {
    const isRead = method.startsWith('conversations.');
    const url = isRead
      ? `https://slack.com/api/${method}?${new URLSearchParams(params)}`
      : `https://slack.com/api/${method}`;
    const response = await fetch(url, {
      method: isRead ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        ...(isRead ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
      body: isRead ? undefined : JSON.stringify(params),
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(`Slack ${method} failed: ${payload.error}`);
    }
    return payload;
  }

  async function findPreviousTag() {
    let release;
    for (let page = 1; ; page++) {
      const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: 100, page });
      for (const candidate of data) {
        if (candidate.draft || candidate.prerelease) continue;
        if (release) return { release, previousTag: candidate.tag_name };
        if (candidate.tag_name === tagName) release = candidate;
      }
      if (data.length < 100) break;
    }
    if (!release) {
      throw new Error(`Release ${tagName} not found among published releases.`);
    }
    return { release, previousTag: undefined };
  }

  async function getReleasedPrNumbers(previousTag) {
    const prNumbers = new Set();
    const perPage = 100;
    for (let page = 1; ; page++) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${previousTag}...${tagName}`,
        per_page: perPage,
        page,
      });
      for (const commit of data.commits) {
        const subject = commit.commit.message.split('\n')[0];
        for (const match of subject.matchAll(/\(#(\d+)\)/g)) {
          prNumbers.add(Number(match[1]));
        }
      }
      if (data.commits.length < perPage) break;
    }
    return [...prNumbers];
  }

  // Changelog posts link to the PR as `<url|#123>`, so the trailing `|` keeps #12 from matching #123.
  async function findChangelogMessages(prUrls) {
    const oldest = (Date.now() / 1000 - lookbackDays * 24 * 60 * 60).toFixed(0);
    const found = new Map();
    let cursor;
    do {
      const payload = await slackApi('conversations.history', {
        channel: slackChannelId,
        oldest,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      for (const message of payload.messages) {
        if (message.thread_ts && message.thread_ts !== message.ts) continue;
        const content = JSON.stringify([message.text, message.blocks]);
        for (const prUrl of prUrls) {
          if (!found.has(prUrl) && content.includes(`${prUrl}|`)) {
            found.set(prUrl, message.ts);
          }
        }
      }
      cursor = payload.response_metadata?.next_cursor;
    } while (cursor && found.size < prUrls.length);
    return found;
  }

  async function alreadyAnnounced(threadTs, releaseUrl) {
    const payload = await slackApi('conversations.replies', {
      channel: slackChannelId,
      ts: threadTs,
      limit: '200',
    });
    return payload.messages.some(message => (message.text || '').includes(releaseUrl));
  }

  const { release, previousTag } = await findPreviousTag();
  if (!previousTag) {
    core.info(`No release before ${tagName}. Nothing to compare against.`);
    return;
  }

  const prNumbers = await getReleasedPrNumbers(previousTag);
  if (prNumbers.length === 0) {
    core.info(`No PRs found between ${previousTag} and ${tagName}.`);
    return;
  }
  core.info(`PRs in ${tagName}: ${prNumbers.map(number => `#${number}`).join(', ')}`);

  const prUrls = prNumbers.map(number => `https://github.com/${owner}/${repo}/pull/${number}`);
  const threads = await findChangelogMessages(prUrls);
  if (threads.size === 0) {
    core.info('None of the released PRs have a CSM changelog post. Nothing to reply to.');
    return;
  }

  const text = `:rocket: Released in <${release.html_url}|${repo} ${tagName}>`;
  for (const [prUrl, threadTs] of threads) {
    if (await alreadyAnnounced(threadTs, release.html_url)) {
      core.info(`Already announced ${tagName} in the thread for ${prUrl}.`);
      continue;
    }
    await slackApi('chat.postMessage', { channel: slackChannelId, thread_ts: threadTs, text });
    core.info(`Replied in the thread for ${prUrl}.`);
  }
};
