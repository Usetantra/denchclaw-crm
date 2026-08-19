# Going live on claw.usetantra.com

The ordering here is not cosmetic. Two steps can lock you out of your own CRM
and one can silently destroy stored credentials, so each is written as a gate
with an explicit "do not proceed until" condition.

Run `node bin/preflight.mjs` on the box at every gate. It is read-only and
exits non-zero when something is genuinely blocking.

---

## Gate 0 — get onto the box, take a backup

Everything below runs **on the server**, as the user that owns the app:

```bash
ssh yogi@staging.usetantra.com          # or whatever the host actually is
cd /home/yogi/denchclaw-crm
git pull                                # bring in bin/, deploy/, migrations/044
npm ci --omit=dev                       # installs @clerk/backend
node -v                                 # MUST be >= 20.9 — see below
```

**If `node -v` is below 20.9**, stop. `@clerk/backend` v3 will fail at require
time and the service will not boot. Upgrade Node first (nvm, or your distro's
nodesource package), then re-run `npm ci`.

Take a backup before touching anything else — every step after this modifies
either the database or the credential encryption:

```bash
sudo mkdir -p /var/backups/denchclaw && sudo chown yogi /var/backups/denchclaw
bin/backup.sh --verify
```

**Do not proceed until** that prints `verified — restores to N tables`. An
unverified backup is a hope, not a rollback plan.

---

## Gate 1 — record the schema, THEN apply 044

The database predates the migration runner, so the first command is `baseline`,
which records the existing files as applied **without executing them**. Running
`up` first would try to re-run `migrate.sql`, which is not idempotent.

```bash
node bin/migrate.mjs status              # expect: 0 applied, 44 pending
node bin/migrate.mjs baseline --dry-run  # read the list — is that this DB's schema?
node bin/migrate.mjs baseline --yes      # records them, runs nothing
node bin/migrate.mjs status              # expect: 44 applied, 0 pending
```

If `status` after baselining does **not** say 0 pending, stop and look: it means
production is missing a migration that was never hand-applied. Apply exactly
those with `node bin/migrate.mjs up`.

Since 043 and 044 may genuinely not be applied on production yet, the honest
sequence is: baseline `--through=` the last one you know was applied by hand,
then `up` the rest.

```bash
# Example, if 042 was the last one applied by hand:
node bin/migrate.mjs baseline --through=042_step_editing.sql --yes
node bin/migrate.mjs up                  # actually runs 043 and 044
```

`up` refuses (exit 2) on a populated database with no records, so a mistake here
fails loudly rather than half-applying.

---

## Gate 2 — CREDENTIALS_KEY, without breaking what is already stored

This is the step that looks like one command and is not. Production almost
certainly already holds provider credentials encrypted under the **derived**
key. Setting `CREDENTIALS_KEY` without re-encrypting them makes every one
permanently unreadable — and `server/db/models/channels.js` swallows the decrypt
error, so the symptom is "the channel says connected but every send fails" with
nothing in the log explaining why.

```bash
# 1. Is anything actually stored?
psql "$DATABASE_URL" -c "SELECT company_id, provider FROM channel_connections WHERE credentials_enc IS NOT NULL"

# 2. Generate the key. Do NOT put it in .env yet.
openssl rand -hex 32

# 3. Prove the re-key works before changing anything.
node bin/rekey-credentials.mjs --new=<the-key> --dry-run

# 4. Do it for real.
node bin/rekey-credentials.mjs --new=<the-key>

# 5. ONLY NOW add it to .env, and restart.
echo "CREDENTIALS_KEY=<the-key>" >> .env
pm2 restart denchclaw-crm
```

If step 1 returns no rows, steps 3–4 are unnecessary — just do 2 and 5.

Between step 4 and step 5 the app still reads the old key, so stored credentials
do not decrypt. Keep that window short and do it when nothing is sending.

Verify afterwards — this must list your channels with their credential keys, not
errors:

```bash
node -e "require('dotenv').config();const b=require('./server/lib/crypto-box');const{Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query('SELECT company_id,provider,credentials_enc FROM channel_connections WHERE credentials_enc IS NOT NULL').then(r=>{
for(const x of r.rows){try{console.log('ok  ',x.company_id+'/'+x.provider,Object.keys(b.decryptJSON(x.credentials_enc)).join(','));}
catch(e){console.log('FAIL',x.company_id+'/'+x.provider,e.message);}}return p.end();});"
```

Then:

```bash
node bin/preflight.mjs
```

---

## Phase 1 — DNS, TLS, and a restart with Clerk still off

### 1a. The DNS record — one record, nothing else

`usetantra.com` is on Cloudflare and carries live production infrastructure:
Google Workspace `MX`, the apex SPF, `resend._domainkey` (the DKIM that **the
CRM's own email sending depends on**), `_dmarc`, and `www`. Record these before
you touch anything, so "unchanged" is checkable rather than remembered:

```bash
dig +short MX usetantra.com
dig +short TXT usetantra.com
dig +short TXT resend._domainkey.usetantra.com
dig +short A usetantra.com api.usetantra.com staging.usetantra.com
```

Better than recording them by hand — snapshot the zone, so "unchanged" becomes
checkable rather than remembered:

```bash
bin/dns-guard.sh snapshot      # read-only, no credentials, cannot modify anything
```

Then, in Cloudflare → `usetantra.com` → DNS → **Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `claw` |
| IPv4 | `20.219.185.55` (the same box as `staging.usetantra.com`) |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

That is the whole zone change. Adding a subdomain A record cannot alter `MX`,
`TXT`, or any sibling — DNS records are independent entries. There is no
wildcard on this zone, so nothing currently answers for `claw` and there is no
conflict.

**Grey cloud, not orange**, for two reasons: every other record in the zone is
DNS-only, and proxying would add a second hop, so `app.set('trust proxy', 1)`
would yield the Cloudflare edge IP instead of the client — breaking the CIDR
allowlist and the per-IP rate limiters.

Two things that *would* damage the zone, neither of which you need:

- **Any operation that replaces the zone** — a zone-file import, a Terraform
  apply with no prior state, an export/edit/re-import. Those can drop
  `resend._domainkey` and the apex SPF, which breaks all outbound mail. Use the
  single-record form.
- **Zone-level Cloudflare settings** (SSL/TLS mode, Always Use HTTPS, Minimum
  TLS) are shared by every record. Change none of them.

Verify — the new record resolves *and* nothing else moved:

```bash
bin/dns-guard.sh verify
```

It diffs the whole zone against the snapshot and exits non-zero if **any** record
other than `claw` was removed, changed, or added. A clean run names what it
checked (MX, DKIM, DMARC, SPF) rather than just saying "ok".

### 1b. TLS — without disturbing the other sites on this box

**This box is shared.** Confirmed by probing it: `20.219.185.55` serves
`staging.usetantra.com` *and* `careers.growthclub.org`, and the latter is the
`default_server` — which is why `claw.usetantra.com` currently answers with the
careers site under a mismatched certificate. That is expected and harmless until
the vhost below lands.

It also means `certbot --nginx` here could rewrite a server block belonging to a
project that has nothing to do with this one. Get the certificate **without
letting certbot touch any config**:

```bash
sudo certbot certonly --webroot -w /var/www/html -d claw.usetantra.com
```

`certbot --nginx` edits server blocks it judges relevant and can add a global
HTTPS redirect. On a box already serving a live vhost, `certonly` is the
difference between "adds a certificate" and "rewrites someone else's site".

### 1c. The vhost

```bash
bin/deploy-claw.sh --dry-run     # prints every command, executes nothing
bin/deploy-claw.sh
```

It obtains the certificate with `certonly`, installs a **new** vhost file,
backs up anything it would replace, runs `nginx -t` **before** any reload so a
bad config can never take the box down, and hard-refuses to target
`staging.usetantra.com` at all. It stops with instructions if the stage-1
placeholders (the internal key, the htpasswd path) are still unfilled, rather
than reloading a config that would 502.

The shipped config is **stage 1**: Basic auth plus key injection, mirroring what
staging does today. It does not require Clerk, so the host works immediately and
nothing about the current security posture changes. Phase 4 converts it to
stage 2.

Leave `staging.usetantra.com/crm/` running. It is the rollback.

```bash
pm2 restart denchclaw-crm
curl -s -o /dev/null -w '%{http_code}\n' https://claw.usetantra.com/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://claw.usetantra.com/crm/     # 401 Basic auth
curl -s -o /dev/null -w '%{http_code}\n' https://staging.usetantra.com/crm/  # still 401
```

**Do not proceed until** all three are as shown — the last one proves you did
not disturb staging.

---

## Phase 1d — re-point everything that names the old host

This is where a host move fails, and it fails **silently**: nothing in this
application errors on a stale hostname.

First, the env. `node bin/preflight.mjs` now checks these and warns when one
points somewhere other than your Clerk origin:

```
APP_URL=https://claw.usetantra.com
MARKETING_PUBLIC_BASE=https://claw.usetantra.com
PUBLIC_BASE_URL=https://claw.usetantra.com
TWILIO_WEBHOOK_BASE_URL=https://claw.usetantra.com
TWILIO_STATUS_CALLBACK=https://claw.usetantra.com/webhooks/twilio/status
```

Then the provider dashboards. Nothing here registers callbacks
programmatically and no full URL is stored in the database — tokens are ours,
hostnames live in *their* dashboards. Find what is actually in use:

```bash
node bin/preflight.mjs | grep -i webhook
```

```sql
SELECT 'lead' AS kind, company_id, label, enabled, request_count, last_used_at FROM lead_webhooks
UNION ALL
SELECT 'tantra', company_id, token, enabled, request_count, last_used_at FROM tantra_webhooks
ORDER BY last_used_at DESC NULLS LAST;
SELECT tool, count(*), max(received_at) FROM webhook_captures GROUP BY tool;
```

Anything with `request_count > 0` has a URL pasted somewhere that still points at
staging:

| Where | What to change |
|---|---|
| Twilio console | inbound webhook on the number / messaging service |
| Cloudflare Worker | `CRM_WEBHOOK_URL` var (`integrations/cloudflare-email/worker.js`) |
| Tantra dashboard | re-paste `/webhooks/tantra/<token>` — **same token, do not regenerate** |
| Zapier / Make / forms | each `/webhooks/leads/<token>` |
| Zoom etc. | any live capture URL |

The dashboard's Integrations panels build these from `location.origin`, so
browsing claw shows the correct URL to copy.

**Staging staying up hides mistakes here** — the old host keeps accepting
callbacks against the same database. That is the price of keeping a rollback,
and it is why Phase 5's cleanup checks the staging access log rather than just
deleting the vhost.

---

## Phase 2 — create the Clerk instance

In the Clerk dashboard:

1. Create a **production** instance for this app. Not a `pk_test_` dev instance —
   dev instances have relaxed limits and dev-mode behaviour.
2. **Restrict sign-up to invitation-only** *before* you set `CLERK_SECRET_KEY`.
   See Phase 3 for why this is not optional.
3. Sessions → Customize session token, add:
   ```json
   { "email": "{{user.primary_email_address}}" }
   ```
   Clerk's default token carries **no email claim**. Without this the server
   falls back to a Backend API call per new identity, and if that also fails
   every new person lands on `no_workspace` with nothing explaining why.
4. Copy the PEM public key (API keys → Show JWT public key).

Then set on the box:

```
CLERK_SECRET_KEY=sk_live_…
CLERK_PUBLISHABLE_KEY=pk_live_…
CLERK_JWT_KEY=<PEM, \n-escaped>
CLERK_AUTHORIZED_PARTIES=https://claw.usetantra.com
CLERK_BOOTSTRAP_COMPANY_ID=tantra
CLERK_SUPERADMIN_COMPANY_IDS=tantra
```

`CLERK_AUTHORIZED_PARTIES` is not optional: unset, the `azp` claim goes
unchecked and a token minted for a *different* app on the same Clerk instance
would be accepted here.

---

## Phase 3 — claim your account. THE LOCK-OUT GATE.

```bash
node bin/preflight.mjs   # look at the tenant "tantra" line
```

**If it reports `tenant "tantra" has NO users`**, the first person to sign up on
your Clerk instance becomes its owner — the bootstrap path in
`users.resolveClerkIdentity` is open until exactly one user exists. That is why
sign-up is restricted in Phase 2. Either leave it restricted, or insert your row
by hand first:

```sql
INSERT INTO users (company_id, email, name, role, status)
VALUES ('tantra', 'you@yourdomain.com', 'Your Name', 'owner', 'active');
```

Then sign in once through the dashboard so the row links to your Clerk identity
(rule 2 — link by email), and verify:

```bash
TOKEN='<copy from the browser: await Clerk.session.getToken()>'
curl -s -H "Authorization: Bearer $TOKEN" https://claw.usetantra.com/crm/api/auth/me
```

**Do not proceed until that returns 200** with `"role":"owner"` and
`"company_id":"tantra"`, and preflight shows `1 linked` for the tenant.

Flipping nginx without this locks every human out, and recovery means an SQL
insert over SSH.

---

## Phase 4 — flip nginx

The config was installed in Phase 1 as **stage 1** (Basic auth + key injection).
This step converts it to **stage 2**: Clerk becomes the gate. In
`/etc/nginx/sites-available/claw.usetantra.com`, all inside the `/crm/` and
`/crm/api/` blocks:

1. **Delete** the `auth_basic` and `auth_basic_user_file` lines — with Clerk in
   front, Basic auth just means signing in twice.
2. **Delete** the two injecting lines:
   `proxy_set_header X-Internal-Key "REPLACE_…";` and
   `proxy_set_header X-Company-Id "tantra";`
3. **Uncomment** the two blanking lines.

```bash
sudo grep -n 'auth_basic\|X-Internal-Key\|X-Company-Id' /etc/nginx/sites-available/claw.usetantra.com
# no auth_basic anywhere, and exactly:
#   proxy_set_header X-Internal-Key "";
#   proxy_set_header X-Company-Id   "";
sudo nginx -t && sudo systemctl reload nginx
```

Step 3 is not optional bookkeeping. nginx forwards client headers **by default**,
so deleting the injection lines without blanking them lets a browser send its
own `X-Internal-Key` and skip Clerk entirely. Deleting alone is worse than
leaving it alone.

**Check before flipping:** do the automation engines or any cron reach the API
through `/crm/api/`? If so, blanking the key kills them instantly and the 401s
appear only in *their* logs. `grep -rn 'crm/api'` across the engines repo, and
check the nginx access log for non-browser user agents.

The reload is atomic and the app has accepted both credentials since Phase 1, so
there is no window where neither works. **Rollback is seconds:** re-add the two
`proxy_set_header` injection lines and reload.

Verify immediately after:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://claw.usetantra.com/crm/api/contacts
# 401 — the "load the URL and you're in" hole is closed

curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Internal-Key: $INTERNAL_API_KEY" https://claw.usetantra.com/crm/api/contacts
# 401 — a browser cannot smuggle its own key past the proxy
```

Both must be 401. If the second returns 200, the header blanking is not in
effect and Clerk is bypassable — roll back and fix before going further.

---

## Phase 5 — turn the crank

Until this is installed the CRM looks completely healthy and sends nothing.

```bash
node bin/tick.mjs --dry-run          # see what it would call
node bin/tick.mjs --tenant=tantra    # one real run
crontab -e -u yogi                   # paste deploy/crontab.example
```

Sending also requires the kill switches on — `EMAIL_EXECUTOR_ENABLED=1` and so
on per channel, and `LIVE_SENDS_DISABLED` unset. Preflight reports both.

Confirm the heartbeat is landing:

```sql
SELECT company_id, channel, last_tick_at FROM ops_channel_state ORDER BY last_tick_at DESC;
```

That table is the only thing that distinguishes "the queue is empty because
everything was delivered" from "the queue is empty because nothing is reading
it". The System health page reads it.

---

## Phase 6 — retire staging (deliberate, and not on day one)

`staging.usetantra.com/crm/` still works and still **injects the internal key**,
so for anyone holding the Basic-auth password it is a complete Clerk bypass. It
is also what has been quietly absorbing any callback you forgot to re-point in
Phase 1d.

Wait until claw has been the working front door for a few days, then check
whether anything still arrives at the old host:

```bash
sudo grep -E ' /(webhooks|m)/' /var/log/nginx/access.log | grep -v ' 404 ' | tail -50
```

Every hit is an integration still pointing at staging. Fix those first — the log
is the only place that evidence exists.

When it is quiet, remove the `/crm/` and `/crm/api/` locations from the staging
vhost (leave the rest of that server block alone), then:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' https://staging.usetantra.com/crm/   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://claw.usetantra.com/crm/      # 200 or Clerk gate
```

---

## Still outstanding after all this

- **Backups are local-only.** `bin/backup.sh` writes to `/var/backups/denchclaw`,
  which survives a bad deploy but not losing the box. Ship it off-box — the
  crudest version that actually works:
  ```bash
  # add after the backup line in cron
  rsync -az /var/backups/denchclaw/ user@otherhost:/backups/denchclaw/
  ```
  Anything is better than nothing here; object storage is better than rsync.
- **The `bin/` tooling has no automated tests.** It was verified by running it
  against real databases, but nothing guards it against regressions.
- **`X-Forwarded-For` is still spoofable** if anything reaches the app without
  passing through nginx. Keep port 3100 bound to loopback and firewalled.
- **Tantra Phase 0 is unverified** — the mirror has never seen a live payload,
  so every field name in `tantra-normalize.js` is a strong reading of their code
  rather than an observed fact. Point it at a real tenant before trusting it.
- **Burn-in cleanup**: after ~a week on Clerk, drop `user_sessions` and
  `users.password_hash`, and delete the password/session code they support.
- **Test-tenant residue.** `bin/tick.mjs` walks every *active* tenant; the dev
  database has ~30 rows of test residue (`auth_test_co_*`, `cpc_*`). Check
  production for the same and archive them, or every cron run does needless work.
