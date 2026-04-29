# .github
Default templates

## Reusable workflows

### CSM changelog

Product repositories can post a release-based Slack digest for customer-visible PRs:

```yaml
name: CSM changelog

on:
  release:
    types: [published]

jobs:
  csm-changelog:
    uses: kindly-ai/.github/.github/workflows/(reusable) csm-changelog.yml@master
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The `@master` reference intentionally gives callers automatic updates when this reusable workflow changes.

Only PRs included in the release are considered. The workflow sends each released PR's title, body, labels, and changed file names to Anthropic, which decides whether the PR is CSM/customer-visible. Included PRs are summarized into one Slack digest.
