module.exports = async function runCsmChangelog({ github, context, core }) {
  const prNumbers = JSON.parse(process.env.PR_NUMBERS || '[]');
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL;
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'SLACK_WEBHOOK_URL']) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
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
  const digestSystemPrompt = `
You write concise Slack changelog digests for Customer Success Managers (CSMs) at Kindly.

Use the included PR summaries to create one cohesive CSM-facing changelog. Group related items when useful. Keep it short, clear, and customer-outcome focused.

Format for Slack mrkdwn. Include PR links inline where relevant using the provided URLs. Do not mention skipped PRs, internal implementation details, Anthropic, or this prompt. Return only the Slack message body, without a title/header.
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

    return parseDecision(textBlock.text);
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

  function formatSlackLine(item) {
    return [
      `*${item.emoji} ${item.headline}*`,
      `<${item.pr.html_url}|#${item.pr.number}> • ${context.repo.owner}/${context.repo.repo}`,
      item.body,
    ].join('\n');
  }

  function getPrReference(items) {
    if (items.length === 1) {
      const { pr } = items[0];
      return { name: `PR #${pr.number}: ${pr.title}`, url: pr.html_url };
    }
    return { name: 'recent merged PRs', url: null };
  }

  async function composeDigest(items) {
    const { name: prName, url: prUrl } = getPrReference(items);
    const prReference = prUrl ? `${prName} (${prUrl})` : prName;
    const userMessage = [
      `repo: ${context.repo.owner}/${context.repo.repo}`,
      `merged_pr: ${prReference}`,
      'included_prs:',
      ...items.map(item => [
        `- pr: #${item.pr.number}`,
        `  url: ${item.pr.html_url}`,
        `  emoji: ${item.emoji}`,
        `  headline: ${item.headline}`,
        `  summary: ${item.body}`,
      ].join('\n')),
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
        max_tokens: 1200,
        system: digestSystemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API failed while composing digest: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const textBlock = payload.content?.find(block => block.type === 'text');
    if (!textBlock?.text) {
      throw new Error('Anthropic response for final digest did not include text content.');
    }

    return textBlock.text.trim();
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

  const includedItems = [];
  const failedItems = [];
  const chunkSize = 5;

  for (let index = 0; index < prNumbers.length; index += chunkSize) {
    const chunk = prNumbers.slice(index, index + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(processPr));

    for (const [resultIndex, result] of chunkResults.entries()) {
      const prNumber = chunk[resultIndex];

      if (result.status === 'fulfilled') {
        if (result.value) {
          includedItems.push(result.value);
        }
        continue;
      }

      failedItems.push({ prNumber, error: result.reason });
      core.warning(`Failed to summarize PR #${prNumber}: ${result.reason?.message || result.reason}`);
    }
  }

  if (includedItems.length === 0) {
    if (failedItems.length > 0) {
      throw new Error(`Failed to summarize ${failedItems.length} PR(s), and no CSM changelog items were available to post.`);
    }

    core.info('No CSM changelog found for this PR.');
    return;
  }

  const { name: prName, url: prUrl } = getPrReference(includedItems);
  const header = prUrl
    ? `*CSM changelog for <${prUrl}|${prName}>*`
    : `*CSM changelog for ${prName}*`;
  let digestBody;

  try {
    digestBody = await composeDigest(includedItems);
  } catch (error) {
    core.warning(`Failed to compose final CSM changelog digest, falling back to per-PR summaries: ${error.message || error}`);
    digestBody = includedItems.map(formatSlackLine).join('\n\n');
  }

  const failureWarning = failedItems.length > 0
    ? [
        `:warning: ${failedItems.length} PR(s) could not be summarized and are missing from this digest:`,
        failedItems.map(item => `<https://github.com/${context.repo.owner}/${context.repo.repo}/pull/${item.prNumber}|#${item.prNumber}>`).join(', '),
      ].join(' ')
    : null;

  const text = [header, digestBody, ...(failureWarning ? [failureWarning] : [])].join('\n\n');

  const response = await fetch(slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }

  if (failedItems.length > 0) {
    core.warning(`Posted a partial CSM changelog. Failed to summarize ${failedItems.length} PR(s): ${failedItems.map(item => `#${item.prNumber}`).join(', ')}`);
  }

  core.info(`Posted ${includedItems.length} CSM changelog item(s) to Slack.`);
};
