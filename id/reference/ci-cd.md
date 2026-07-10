# CI/CD

GitHub Actions workflows in `.github/workflows/`:

## CI Workflows

- `ci.codeql.yml` — CodeQL analysis
- `ci.codecov.yml` — test coverage upload
- `ci.codacy.yml` — Codacy quality
- `ci.sonarqube.yml` — SonarQube
- `ci.npm-audit.yml` — dependency audit
- `ci.pr-guard.yml` / `ci.pr-lint-feedback.yml` — PR validation

## CD Workflows

- `cd.release.yml` — release automation (version bump, changelog, publish)
- `cd.gh-pages.yml` — docs site deployment

## Bot Workflows

- Issue claims, moderation, stale claims, nuke, pin SHAs to actions
