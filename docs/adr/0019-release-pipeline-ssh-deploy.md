# 0019. Releases: a tag builds the images and deploys them over SSH with a key that can only deploy

- Status: Accepted
- Date: 2026-10-17

## Context

ADR 0018 puts the stack on one EC2 instance that pulls prebuilt images. Something has to build
those images and tell the server to switch to them. Doing it by hand (build on the laptop, push,
SSH in, deploy) works but is easy to get wrong: an image built from uncommitted files, a laptop
built for arm64 while the server is amd64, a step forgotten. CI can do it the same way every time,
but CI then needs a way into the server, and that way in is the most sensitive credential in the
project.

## Decision

**Pushing a `v*` tag runs `.github/workflows/release.yml`:**

1. Build the server and web images for `linux/amd64` with Buildx (layer cache in GitHub Actions)
   and push them to GHCR as `:<tag>` and `:latest`, signed in with the workflow's own
   `GITHUB_TOKEN`. No registry password is stored anywhere.
2. SSH to the server and deploy that tag (`tixora.sh deploy`: check out the tag, pull its images,
   `docker compose up --wait`, which returns only when every service is healthy).
3. Check the live site over HTTPS: the web page, an API route through nginx and an API replica,
   and that plain HTTP redirects. The job fails if any of them does not answer.

The deploy job uses a GitHub `production` environment, so each deploy is recorded on the
repository with the site's address.

**The CI key can only deploy.** Its line in the server's `authorized_keys` forces one command and
disables everything else:

```text
command="/opt/tixora/infra/deploy/tixora.sh ci-deploy",restrict ssh-ed25519 AAAA… tixora-ci
```

Whatever CI asks to run arrives as `SSH_ORIGINAL_COMMAND`, and `ci-deploy` accepts it only if it
is exactly a release tag (`v1.2.3`, optionally `-rc.1`); anything else is refused. A leaked key
lets someone redeploy a release that already exists, not open a shell. The server's host key is
pinned in a secret (`DEPLOY_KNOWN_HOSTS`), so CI will not talk to a server it has not seen before.

**Port 22 is open to the internet, with keys only.** GitHub's runners have no fixed addresses, so
SSH cannot be limited to them. Password login stays disabled (the Ubuntu image's default) and every
key on the instance is either the owner's or the restricted CI key.

Secrets in the repository: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.

## Alternatives considered

- **Deploy by hand from the laptop, CI only builds.** No open SSH port needed beyond the owner's
  address, but every release depends on remembering the steps.
- **AWS Systems Manager Run Command with GitHub OIDC.** No SSH port at all and no long-lived key:
  GitHub gets short-lived AWS credentials and asks the instance's SSM agent to run the deploy. The
  better design for a team; here it means an IAM role, an OIDC provider and a trust policy for one
  command, and ties the pipeline to AWS. Worth switching to if the project outgrows one server.

## Consequences

- A release is one command (`git push origin v1.0.0`), and the commit it deploys is one CI already
  tested on main.
- Redeploying is re-running the workflow; rolling back is `./tixora.sh deploy <older tag>` on the
  server (or re-running that tag's workflow), since every release's images stay in GHCR.
- GHCR packages start private; they have to be made public once (runbook) so the server can pull
  without a token.
- The SSH port is exposed to scanners. With key-only login that costs log noise, not access.
