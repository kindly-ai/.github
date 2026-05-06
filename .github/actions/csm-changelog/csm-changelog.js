module.exports = async function runCsmChangelog({ github, context, core }) {
  const prNumber = Number(process.env.PR_NUMBER);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL;
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  for (const name of ['PR_NUMBER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'SLACK_WEBHOOK_URL']) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR_NUMBER must be a positive integer. Received: ${process.env.PR_NUMBER}`);
  }

  const systemPrompt = `
You write changelog blurbs for Customer Success Managers (CSMs) at Kindly.

Decide whether a merged GitHub PR matters to CSMs or customers. Include only changes with likely customer-facing impact:
- end-user behavior in the chat widget or bot
- admin, bot-builder, or workflow UX
- customer-visible APIs, integrations, Actions, or security/privacy fixes
- bug fixes customers could notice or have reported
- new capabilities or meaningful UX improvements

Skip internal-only changes:
- dependency bumps
- tests, CI, lint, formatting, Storybook, build config
- pure refactors, dead code removal, type-only changes
- unreleased experiments, feature-flag-only internal prep, or scratch work
- translation-only or generated-file-only changes

Write in plain English. Avoid implementation jargon like TypeScript, null/undefined, regex, race condition, hydration, SSR, database migration, GraphQL, or API internals unless the audience is explicitly API customers.

Return one JSON object only. For included PRs:
{
  "skip": false,
  "emoji": ":sparkles:",
  "headline": "Sentence case headline with no trailing punctuation",
  "body": "One to three short sentences explaining what changed and why customers/CSMs care."
}

For skipped PRs:
{
  "skip": true,
  "reason": "Short reason"
}
  `.trim();
  function cleanBody(value) {
    return value
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('- [ ]') && !line.startsWith('- [x]'))
      .join('\n')
      .trim();
  }

  function parseDecision(text) {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }

  function formatModelTextForLog(text) {
    return text
      .replace(/\s+/g, ' ')
      .slice(0, 2000);
  }

  async function summarizePr(pr, files) {
    const labels = (pr.labels || []).map(label => label.name).filter(Boolean);
    const userMessage = [
      `repo: ${context.repo.owner}/${context.repo.repo}`,
      `pr_number: ${pr.number}`,
      `title: ${pr.title}`,
      `author: ${pr.user?.login || 'unknown'}`,
      `labels: ${JSON.stringify(labels)}`,
      `files_changed: ${JSON.stringify(files.map(file => file.filename).slice(0, 100))}`,
      'body: |',
      cleanBody(pr.body || '')
        .slice(0, 8000)
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n'),
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API failed for PR #${pr.number}: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const textBlock = payload.content?.find(block => block.type === 'text');
    if (!textBlock?.text) {
      throw new Error(`Anthropic response for PR #${pr.number} did not include text content.`);
    }

    try {
      return parseDecision(textBlock.text);
    } catch (error) {
      throw new Error(`Could not parse Anthropic JSON decision for PR #${pr.number}: ${error.message}. Response: ${formatModelTextForLog(textBlock.text)}`);
    }
  }

  function shouldSkipLocally(pr) {
    const title = pr.title || '';
    const author = pr.user?.login || '';
    return (
      author === 'dependabot[bot]' ||
      pr.user?.type === 'Bot' ||
      /^⬆️ ?Bump /i.test(title) ||
      /^Bump /i.test(title)
    );
  }

  function formatSlackMessage(item) {
    return [
      `*CSM changelog for <${item.pr.html_url}|PR #${item.pr.number}: ${item.pr.title}>*`,
      '',
      `*${item.emoji} ${item.headline}*`,
      item.body,
    ].join('\n');
  }

  async function processPr(prNumber) {
    const { data: pr } = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
    });

    if (!pr.merged_at) {
      throw new Error(`PR #${prNumber} has not been merged. The CSM changelog only runs for merged PRs.`);
    }

    if (shouldSkipLocally(pr)) {
      core.info(`Skipping PR #${prNumber}: obvious bot/dependency PR.`);
      return null;
    }

    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const decision = await summarizePr(pr, files);
    if (decision.skip) {
      core.info(`Skipping PR #${prNumber}: ${decision.reason || 'Anthropic marked it as not CSM-visible.'}`);
      return null;
    }

    if (!decision.emoji || !decision.headline || !decision.body) {
      throw new Error(`Anthropic decision for PR #${prNumber} is missing required fields: ${JSON.stringify(decision)}`);
    }

    return {
      pr,
      emoji: decision.emoji,
      headline: decision.headline,
      body: decision.body,
    };
  }

  const item = await processPr(prNumber);
  if (!item) {
    core.info('No CSM changelog found for this PR.');
    return;
  }

  const response = await fetch(slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: formatSlackMessage(item) }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }

  core.info(`Posted CSM changelog for PR #${item.pr.number} to Slack.`);
};
