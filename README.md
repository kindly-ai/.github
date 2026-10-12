# .github

Default templates

## Reusable workflows

### CSM changelog

Product repositories can post a Slack changelog message when a customer-visible PR is merged:

```yaml
name: CSM changelog

on:
  pull_request:
    types: [closed]

jobs:
  csm-changelog:
    if: ${{ github.event.pull_request.merged == true }}
    uses: kindly-ai/.github/.github/workflows/(reusable) csm-changelog.yml@master
    with:
      pr-number: ${{ github.event.pull_request.number }}
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The `@master` reference intentionally gives callers automatic updates when this reusable workflow changes.

Only the merged PR passed by `pr-number` is considered. The workflow sends the PR's title, body, labels, and changed file names to Anthropic, which decides whether the PR is CSM/customer-visible and writes a short changelog entry. The action also verifies that the PR is merged before posting, so accidental calls for open or closed-unmerged PRs fail.

#### Testing locally

A test script lets you run the action from your machine against a real merged PR without needing to merge a branch first.

**Prerequisites:** `gh` CLI (logged in) and Node.js.

Fill in `.github/actions/csm-changelog/.env`:

```
PR_NUMBER=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
SLACK_WEBHOOK_URL=
REPO_OWNER=kindly-ai
REPO_NAME=kindly

```

Then run from the repo root:

```bash
node .github/actions/csm-changelog/test-local.js
```

### CSM changelog release

When a release is published, this replies "🚀 Released in <repo> vX.Y.Z" in the Slack thread of each CSM changelog post whose PR is part of the release:

```yaml
name: CSM changelog release

on:
  release:
    types: [published]

jobs:
  csm-changelog-release:
    uses: kindly-ai/.github/.github/workflows/(reusable) csm-changelog-release.yml@master
    secrets:
      slack-bot-token: ${{ secrets.SLACK_CHANGELOG_BOT_TOKEN }}
      slack-channel-id: ${{ secrets.SLACK_CHANGELOG_CHANNEL_ID }}
```

The released PRs are the `(#123)` references in the commit subjects between the previous published release and this one. The workflow then searches the last 30 days of channel history (`lookback-days`) for posts linking to those PRs, and replies in their threads. PRs that were skipped as not CSM-visible have no post and are ignored. Re-running the workflow does not reply twice.

The bot token must belong to the same Slack app as the CSM changelog webhook, with the `chat:write` and `channels:history` scopes (`groups:history` for a private channel), and the app must be a member of the channel.
