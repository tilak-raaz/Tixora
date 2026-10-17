# Deploy to AWS

From nothing to `https://tixora.tilakraaz.cloud` running a release, then day-to-day operation. The
design and its trade-offs: [ADR 0018](../adr/0018-deploy-single-ec2-compose.md) (one EC2 instance,
images from GHCR, HTTPS) and [ADR 0019](../adr/0019-release-pipeline-ssh-deploy.md) (a tag builds
and deploys; the CI key can only deploy).

```text
git push origin v1.2.3
  └─▶ GitHub Actions: build server + web images ──▶ GHCR
                      ssh (deploy-only key) ──▶ EC2: tixora.sh deploy v1.2.3
                                                  pull images, docker compose up --wait
                      check https://tixora.tilakraaz.cloud

browser ──▶ :443 nginx (Let's Encrypt) ─┬─ /api/*, /webhooks/* ──▶ api ×3
                                        └─ everything else ─────▶ web
           Postgres, Redis, workers ×2, seeder (daily), certbot (renewals) on the same instance
```

Commands marked **Mac** run in your terminal, **server** ones over SSH. Nothing secret goes in the
repository: secrets live in the server's `infra/deploy/.env` and in GitHub's encrypted secrets.

## 0. Before you start

- **AWS:** pick **Asia Pacific (Mumbai) `ap-south-1`** in the region menu (top right) and keep it for
  every step. In **Billing and Cost Management → Budgets → Create budget**, make a monthly cost
  budget (say $10) that emails you, and check **Billing → Credits** now and then. The free plan
  ends when its credits run out or after its time limit, whichever is first; upgrade the account
  before then to keep the site.
- Accounts: [Resend](https://resend.com) (email) and [Razorpay](https://dashboard.razorpay.com)
  (test mode is enough).
- Hostinger access to the DNS of `tilakraaz.cloud`.

## 1. Launch the server

**EC2 → Instances → Launch instances:**

| Setting               | Value                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                  | `tixora`                                                                                                                                             |
| Image                 | **Ubuntu Server 24.04 LTS**, architecture **64-bit (x86)**: the images are built for amd64                                                           |
| Instance type         | `t3.small`                                                                                                                                           |
| Key pair              | **Create new key pair**: name `tixora-admin`, type ED25519, format `.pem`. It downloads once                                                         |
| Network settings      | Create a security group `tixora` allowing **SSH from Anywhere**, **HTTPS from the internet**, **HTTP from the internet** (why SSH is open: ADR 0019) |
| Storage               | 20 GiB gp3                                                                                                                                           |
| Advanced → Credit     | **Standard**. With Unlimited, sustained CPU above the t3 baseline is billed extra                                                                    |
| Advanced → Monitoring | Detailed CloudWatch monitoring **Disable**; basic monitoring is free, detailed is billed                                                             |

Then give it a fixed address: **EC2 → Elastic IPs → Allocate Elastic IP address**, then **Actions →
Associate Elastic IP address** → instance `tixora`. Write the address down; below it is `<IP>`.

**Mac:** keep the key safe and give the server a short name.

```bash
mv ~/Downloads/tixora-admin.pem ~/.ssh/
chmod 400 ~/.ssh/tixora-admin.pem
cat >> ~/.ssh/config <<'CONF'

Host tixora
  HostName <IP>
  User ubuntu
  IdentityFile ~/.ssh/tixora-admin.pem
CONF
ssh tixora
```

Answer `yes` to the host key question the first time. Later steps reuse that answer.

## 2. Prepare the server

**Server:** updates, 2 GB of swap (Postgres, Redis and six Node processes share 2 GB of memory),
Docker.

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

If the upgrade printed `*** System restart required ***` (a new kernel), run `sudo reboot` now, while nothing is running yet, and wait half a minute.

**Mac:** `ssh tixora` again (the group change needs a new login), then on the **server**:

```bash
docker run --rm hello-world
free -h
sudo mkdir -p /opt/tixora
sudo chown ubuntu:ubuntu /opt/tixora
git clone https://github.com/tilak-raaz/Tixora.git /opt/tixora
cd /opt/tixora/infra/deploy
cp .env.example .env
chmod 600 .env
```

`free -h` should show 2.0Gi of swap. Ubuntu installs security updates by itself
(unattended-upgrades); containers come back after a reboot (`restart: unless-stopped`).

## 3. Point the domain at it

**Hostinger → Domains → `tilakraaz.cloud` → DNS records → Add record:** type **A**, name
`tixora`, points to `<IP>`, TTL `300` (Hostinger suggests 14400, four hours, which makes any mistake slow to fix).

**Mac:** wait until this prints `<IP>` (usually minutes):

```bash
dig +short tixora.tilakraaz.cloud
```

## 4. Email: Resend

1. **Resend → Domains → Add domain:** `tilakraaz.cloud`. Resend lists a few DNS records (DKIM,
   SPF and a bounce MX on a `send` subdomain). Add each in Hostinger exactly as shown (Hostinger
   adds the domain to the name itself, so enter only the part before `.tilakraaz.cloud`). They do
   not touch any email you receive on the domain. Press **Verify** until it shows Verified.
2. **Resend → API Keys → Create API key:** permission **Sending access**, domain
   `tilakraaz.cloud`. It is shown once: it goes straight into `.env` in step 6.

## 5. Payments: Razorpay test mode

1. Switch the dashboard to **Test Mode**.
2. **Account & Settings → API Keys → Generate Test Key:** the key id (`rzp_test_...`) and secret.
   A test key you already use for another project can be reused (generating a new one may
   replace it); the webhook below is still its own, with its own secret. Razorpay sends every
   event in the account to every active webhook: Tixora checks the signature and ignores orders it
   did not create, so delete webhooks of projects that no longer run.
3. **Account & Settings → Webhooks → Add new webhook:**
   - **URL:** `https://tixora.tilakraaz.cloud/webhooks/razorpay`
   - **Secret:** make one with `openssl rand -hex 24` (**Mac**) and keep it for `.env`
   - **Active events:** `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`,
     `refund.failed`

Bookings are confirmed only by this webhook, never by the browser
([payments runbook](payments-local.md)).

## 6. Fill in `.env`

**Server:** `cd /opt/tixora/infra/deploy`, then make the two internal secrets and open the file:

```bash
openssl rand -base64 32
openssl rand -base64 32
nano .env
```

| Setting                                                             | Value                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ACME_EMAIL`                                                        | your email; Let's Encrypt writes only if renewal keeps failing      |
| `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`                           | one `openssl` output each                                           |
| `RESEND_API_KEY`                                                    | from step 4                                                         |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from step 5                                                         |
| `API_REPLICAS`, `WORKER_REPLICAS`                                   | 3 and 2 to start; 2 and 1 if memory is short (section "Day to day") |

Leave `DOMAIN`, `TAG` and `EMAIL_FROM` as they are. Change `POSTGRES_PASSWORD` only before the
first start: Postgres keeps the password it was created with.

## 7. Get the certificate

**Server** (DNS from step 3 must already point here, and port 80 must be open):

```bash
./tixora.sh tls-init
```

It ends with `certificate ready for tixora.tilakraaz.cloud`. Renewals happen by themselves from now
on.

## 8. Let GitHub deploy

A second key, used only by GitHub Actions, that the server lets run nothing but a deploy of a
release tag.

**Mac:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/tixora-ci -N '' -C tixora-ci
echo "command=\"/opt/tixora/infra/deploy/tixora.sh ci-deploy\",restrict $(cat ~/.ssh/tixora-ci.pub)" | ssh tixora 'cat >> ~/.ssh/authorized_keys'
ssh -i ~/.ssh/tixora-ci -o IdentitiesOnly=yes ubuntu@<IP> main
```

The last line must print `refusing: 'main' is not a release tag`: the key works, and works only for
that.

**GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret**,
four times:

| Secret               | Value                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`        | `<IP>`                                                                                                              |
| `DEPLOY_USER`        | `ubuntu`                                                                                                            |
| `DEPLOY_SSH_KEY`     | the private key: `pbcopy < ~/.ssh/tixora-ci`, then paste                                                            |
| `DEPLOY_KNOWN_HOSTS` | the server's host key as your Mac accepted it in step 1: `ssh-keygen -F <IP> \| grep -v '^#' \| pbcopy`, then paste |

`~/.ssh/tixora-ci` is not needed on the Mac after this. To rotate it, make a new one, replace its
line in the server's `~/.ssh/authorized_keys` and update `DEPLOY_SSH_KEY`.

## 9. First release: a release candidate

A trial tag first, so problems show up before `v1.0.0` exists. **Mac:**

```bash
git switch main
git pull
git tag -a v1.0.0-rc.1 -m "v1.0.0-rc.1"
git push origin v1.0.0-rc.1
```

Watch **Actions → Release**: **Image (server)**, **Image (web)**, then **Deploy**, which runs
`tixora.sh deploy v1.0.0-rc.1` on the server (the first start takes a few minutes: images,
migrations, the seeder loading the catalogue) and checks the live site.

The server pulls the images without a token, so the GHCR packages must be public. Packages pushed
from a public repository's workflow with the source label (which the workflow sets) are linked to
the repository and come out public. Check once: **your profile → Packages → `tixora-server` →
Package settings** says "This package is currently public", and the same for `tixora-web`. If one
is private, Deploy fails with `denied`: **Change visibility → Public**, then **Re-run failed
jobs**.

On this first run the server still runs the `tixora.sh` it was cloned with (see "Day to day"), so
deploy the same tag once more by hand to let the current script finish its work (it records the
running release in `.env`); nothing is recreated:

```bash
cd /opt/tixora/infra/deploy
./tixora.sh deploy v1.0.0-rc.1
grep '^TAG=' .env
```

**Server:** create the admin account (email and password are asked for, not typed on the command
line):

```bash
cd /opt/tixora/infra/deploy
./tixora.sh admin
```

## 10. Check it like a user

1. `https://tixora.tilakraaz.cloud` opens with a padlock; `http://` redirects to it.
2. Pick a city and a show; the seat map loads.
3. Sign up, hold seats, pay with a Razorpay test method ([payments runbook](payments-local.md)):
   the page shows the ticket within seconds (the webhook arrived).
4. The confirmation email arrives (check spam the first time).
5. Open the same show in a second browser and hold a seat in the first: it turns taken in the
   second at once (live updates through nginx).
6. Sign in as the admin.

All good: tag the same commit `v1.0.0` (the release PR does this).

## Day to day

**Release:** merge to main, then **Mac** `git tag -a vX.Y.Z -m "vX.Y.Z"` and
`git push origin vX.Y.Z`. Actions builds, deploys and checks. A deploy restarts containers, so
requests and seat streams in flight at that moment are dropped and clients reconnect.

**Changes to `tixora.sh` itself** take effect from the deploy after the one that brings them: a
deploy runs the copy that was on the server before it checked out the new tag (the script reads
itself in full first, so the checkout cannot change it halfway). Deploying the same tag again
applies them.

**Roll back** (**server**): `./tixora.sh deploy <older tag>`; every release's images stay in GHCR.
Migrations are not undone, so a migration must keep working with the previous release's code.

**Change a setting** (**server**): edit `.env`, then `./tixora.sh deploy "$(grep ^TAG= .env | cut -d= -f2)"`.
Compose recreates only the containers whose settings changed.

**Look** (**server**, in `/opt/tixora/infra/deploy`):

```bash
./tixora.sh ps
./tixora.sh logs api
./tixora.sh logs worker
free -h
docker stats --no-stream
```

If swap use keeps growing or containers restart with exit code 137 (killed for memory), lower
`API_REPLICAS` and `WORKER_REPLICAS` to 2 and 1 before thinking about a bigger instance.

**Certificate:** `docker compose logs certbot` shows renewal attempts. To try a renewal without
using one: `docker compose run --rm --entrypoint certbot certbot renew --dry-run --webroot -w /var/www/certbot`.

**Shows:** the seeder adds the coming week's shows every day; `./tixora.sh seed` does it now.

## Optional: disk snapshots

There are no database backups, by decision (ADR 0018: everything in it is demo data). For a safety
net anyway: **EC2 → Lifecycle Manager → Create lifecycle policy → EBS snapshot policy**, target
instances tagged `Name = tixora`, daily, keep 7. Snapshots are incremental and cost cents a month.
Restoring means a new volume from a snapshot attached to a new instance.

## When something goes wrong

| Symptom                                                | Likely cause and fix                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tls-init` fails with a connection or DNS error        | `dig +short tixora.tilakraaz.cloud` is not `<IP>` yet, or the security group lacks HTTP 80. Let's Encrypt rate-limits failures: fix it before retrying |
| Deploy fails with `denied` pulling an image            | A GHCR package is still private (step 9)                                                                                                               |
| Deploy fails with `Host key verification failed`       | `DEPLOY_KNOWN_HOSTS` is wrong, or the instance was replaced: redo it from step 8                                                                       |
| Deploy fails with `refusing: '…' is not a release tag` | The tag is not `vX.Y.Z` or `vX.Y.Z-suffix`                                                                                                             |
| Deploy times out waiting for health                    | `./tixora.sh ps` and `./tixora.sh logs api`; a missing or wrong `.env` setting stops the API at start with a message naming it                         |
| The site answers 502                                   | No healthy API replica or web server: `./tixora.sh ps`, then the logs of the unhealthy one                                                             |
| Payments stay "Confirming"                             | The webhook is not arriving: Razorpay → Webhooks shows each delivery and its response. A 401 there means `RAZORPAY_WEBHOOK_SECRET` differs             |
| No emails                                              | Resend domain not Verified, or `./tixora.sh logs worker` shows Resend refusing the key                                                                 |

## Take it down

Terminate the instance, then **release the Elastic IP** (an unattached one is still billed), delete
the `tixora` A record and the Resend records in Hostinger, delete the four `DEPLOY_*` secrets, and
remove the webhook in Razorpay.
