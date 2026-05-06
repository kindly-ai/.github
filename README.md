# .github
Default templates

## Reusable workflows

### CSM changelog

Product repositories can post a Slack digest when a customer-visible PR is merged:

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

Only the merged PR passed by `pr-number` is considered. The workflow sends the PR's title, body, labels, and changed file names to Anthropic, which decides whether the PR is CSM/customer-visible. Included PRs are summarized into one Slack digest. The action also verifies that the PR is merged before posting, so accidental calls for open or closed-unmerged PRs fail.
