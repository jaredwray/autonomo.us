# Security

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Report vulnerabilities privately via [GitHub private vulnerability reporting](https://github.com/jaredwray/autonomo.us/security/advisories/new), or by emailing `me@jaredwray.com`. You should receive a response within 72 hours. Please include enough detail to reproduce the issue (affected component, steps, impact).

## Supply chain security policy

This repository follows the [Defense in Depth (Node.js)](https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md) operating manual. The core principle: make compromise require multiple independent failures, reduce the blast radius of any one failure, and create public evidence when a release does not match the expected process.

Controls enforced through pnpm (configured in `pnpm-workspace.yaml`):

- **Package manager is pinned** (`packageManager` in `package.json`, with integrity hash). CI and Docker builds activate pnpm through Corepack, which downloads exactly the pinned version and verifies it against the committed hash before pnpm ever runs.
- **Seven-day release maturity delay**: new dependency versions must be at least 7 days old before pnpm will resolve to them (`minimumReleaseAge: 10080`). Resolution fails closed when no version qualifies (`minimumReleaseAgeStrict: true`) or when registry publish-time metadata is missing (`minimumReleaseAgeIgnoreMissingTime: false`).
- **Exotic transitive dependencies are blocked** (`blockExoticSubdeps: true`): only direct dependencies may use git or tarball-URL sources.
- **Dependency build scripts do not run unless approved** (`strictDepBuilds: true`, `dangerouslyAllowAllBuilds: false`). The `allowBuilds` list in `pnpm-workspace.yaml` is the code-reviewed approval policy. Every addition to that list is a security exception and requires human review of the package's install scripts. Run `pnpm approve-builds` only as part of dependency review — never automatically and never in CI.
- **Trust downgrades fail installs** (`trustPolicy: no-downgrade`).

## Defense in Depth status

Single source of truth for the Defense in Depth rollout. One item per PR. Legend: `[ ]` not started · `[ ] (PR #n pending)` implementation PR open · `[x] — PR #n` merged · `[x] — already in place` satisfied before this rollout · `(manual)` external/manual item that never gets an automated PR.

### 1. Maintainer identity and account security (manual)

- [ ] Use phishing-resistant 2FA for npm, GitHub, Google Workspace, email, and password-manager accounts. (manual)
- [ ] Prefer hardware security keys or platform passkeys over SMS/TOTP where supported. (manual)
- [ ] Create a dedicated release identity for Sigstore/Cosign keyless approval. (manual)
- [ ] Enforce Google Workspace 2SV/security keys for release identities. (manual)
- [ ] Store recovery codes offline and document account recovery procedures. (manual)
- [ ] Remove inactive npm collaborators and GitHub maintainers quarterly. (manual)
- [ ] Require npm package setting: two-factor authentication and disallow tokens (once packages are published). (manual)
- [ ] Revoke unused npm automation tokens. (manual)
- [ ] Never store npm publish tokens in GitHub Actions secrets. (manual)

### 2. Device, VM, and workspace isolation (manual)

- [ ] Use isolated coding VMs between companies. (manual)
- [ ] Use separate VMs for high-risk or high-download OSS project families where practical. (manual)
- [ ] Keep the release VM separate from general development. (manual)
- [ ] Do not share browser/npm/GitHub sessions or cloud credentials across company/project VMs. (manual)
- [ ] Keep release signing keys out of normal development shells. (manual)
- [ ] Do not install random global npm packages on the release VM. (manual)
- [ ] Restrict release VM network and credential access to what release tasks require. (manual)
- [ ] Rebuild or rotate VMs after suspicious dependency installs. (manual)

### 3. Dependency policy

- [ ] Move direct dependencies from broad ranges to narrower ranges where reasonable (`~` over `^` for runtime deps; exact versions for release tooling and security-sensitive deps; keep peer ranges compatible).
- [x] Require committed lockfiles for every repo. — already in place (`pnpm-lock.yaml` is committed)
- [ ] All GitHub Actions installs use exactly `pnpm install --frozen-lockfile`. (Docker builds already use it; workflows do not yet.)
- [ ] Block CI if the lockfile would be modified.
- [x] Dependency-update tool PRs go through normal review, never auto-merge. — n/a (no dependency-update tool is configured; adding one is the maintainer's call, and this policy applies if one is added)
- [ ] Require human review for any new direct dependency.
- [ ] Require additional review for dependencies with install scripts, native builds, binary downloads, exotic sources, or recent ownership changes.

### 4. pnpm 11 supply chain controls

- [x] Pin the package manager in `package.json`. — PR #9
- [x] Enforce a seven-day maturity delay with `minimumReleaseAge: 10080`. — PR #9
- [x] Set `minimumReleaseAgeStrict: true` so resolution fails instead of falling back to too-new versions. — PR #9
- [x] Set `minimumReleaseAgeIgnoreMissingTime: false` so missing publish-time metadata fails closed. — PR #9
- [x] Explicitly set `blockExoticSubdeps: true`. — PR #9
- [x] Use `allowBuilds` (replaces `onlyBuiltDependencies` and related pre-pnpm-11 settings). — PR #9
- [x] Keep `dangerouslyAllowAllBuilds: false`. — PR #9
- [x] Treat every new lifecycle script approval as a security exception. — PR #9
- [x] Maintain approved build scripts as code-reviewed policy (`allowBuilds` in `pnpm-workspace.yaml`), not one-off developer prompts. — PR #9
- [x] Run `pnpm approve-builds` only as part of dependency review, never automatically in CI. — PR #9

### 5. GitHub Actions hardening

- [ ] Default all workflows to read-only permissions (`permissions: contents: read`). (PR #11 pending)
- [ ] Give `id-token: write` only to the final publish job. (No publish workflow exists yet; applies when one is added.)
- [x] No npm tokens in GitHub Actions. — already in place (workflows reference no npm tokens; secrets are provider API keys only)
- [ ] Pin all third-party actions to a full commit SHA; treat tag- or branch-pinned actions as policy violations.
- [ ] Add `.github/CODEOWNERS` with a wildcard rule so every PR — including workflow, release-script, and package-manager-config changes — requires code-owner review; enable "Require review from Code Owners" branch protection. (Branch-protection toggle is manual.)
- [x] Avoid `pull_request_target` for workflows that check out or execute untrusted PR code. — already in place (not used)
- [x] Do not share caches across trust boundaries. — already in place (no workflow caching is used)
- [ ] Disable package-manager caching in release builds. (No release builds yet; applies when one is added.)
- [x] Do not use self-hosted runners for public PR workflows. — already in place (GitHub-hosted runners only)
- [x] If self-hosted runners are unavoidable, use just-in-time/ephemeral runners with no resident secrets. — n/a (no self-hosted runners)
- [ ] Prevent GitHub Actions from creating or approving PRs unless explicitly needed (repository Actions settings). (manual)
- [ ] Run GitHub workflow/security scans on every PR touching CI, package manifests, lockfiles, release scripts, or security policy.

### 6. Release management

Tracked separately: release pipeline hardening is covered by the `release-management-nodejs` skill and, once that work begins, lives in a `Release Management status` block in this file — not in this block.

### 7. npm package settings (manual)

- [ ] Use npm org/package ownership intentionally; avoid broad owner lists. (manual)
- [ ] Configure trusted publishing only where the release workflow is fully hardened. (manual)
- [ ] For packages using trusted publishing, require two-factor authentication and disallow tokens after confirming the trusted publisher works. (manual)
- [ ] For packages not using trusted publishing, publish locally with interactive 2FA only. (manual)
- [ ] Audit trusted publisher settings regularly. (manual)
- [ ] Keep `repository.url` accurate so npm trusted publishing/provenance checks map to the expected repo. (manual)

### 8. Security tooling and detection

- [x] Keep Aikido running on every build. — already in place (Aikido GitHub app scans every PR)
- [x] Add Socket.dev as a second detection layer. — already in place (Socket GitHub app runs PR alerts and project reports)
- [ ] Evaluate Socket Gateway in report-only mode first; move to default-blocking only after tuning false positives and emergency bypass rules. (manual)
- [ ] Run `deepsec` on PRs, especially PRs touching release paths, dependency files, CI, auth, crypto, or package boundaries.
- [ ] Run secret scanning on repos and local/CI artifacts.
- [ ] Generate SBOMs for releases.
- [ ] Monitor npm package versions, dist-tags, and package settings for unexpected changes. (manual)
- [ ] Monitor GitHub audit events for workflow edits, tag creation, repo visibility changes, secret changes, and environment-rule changes. (manual)

### 9. Public transparency

- [ ] Publish release policy in `SECURITY.md`.
- [ ] Publish approved signer identities and key fingerprints on `jaredwray.com`. (manual)
- [ ] Publish release verification instructions for users.
- [ ] Publish a per-release `release-intent.json` and signature bundle.
- [ ] Publish final tarball signature bundles and SHA256 digests as release assets.
- [ ] State clearly: a release without valid owner approval is suspicious even if it has npm provenance.

### 10. Incident response

- [ ] Treat any host that installed a known malicious package as compromised.
- [ ] Rotate npm, GitHub, Google, cloud, SSH, package-registry, and CI credentials reachable from the host.
- [ ] Purge private registry and package-manager caches after confirmed malicious versions.
- [ ] Deprecate malicious package versions immediately.
- [ ] Publish an incident notice with affected versions, timeframe, impact, IOCs, and recommended customer actions.
- [ ] Rebuild release and development VMs after serious dependency or credential exposure.
- [ ] Run a quarterly release-compromise tabletop exercise. (manual)
