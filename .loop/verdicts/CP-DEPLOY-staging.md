# CP-DEPLOY — merge + staging deploy + verification: **DONE (2 of 3)**

Operator lifted the standing "never push to main / never deploy" rules and asked for all three.

## 1. Merge to main — DONE

PR [#6](https://github.com/Usetantra/denchclaw-crm/pull/6) merged. `origin/main` **`9ff21cb → c9ddcbd`**,
gaining 50 commits. Verified `stage-authority.js`, `026_legacy_stage_modes.sql`, `apply-schema.mjs`
and `DEPLOY_RUNBOOK.md` all present on `main`.

## 2. Deploy to staging — DONE

Followed the runbook exactly: **DDL before restart**, because `/health` returns 200 while every
authenticated request 401s if the migrations are missing.

| Step | Result |
|---|---|
| pre-deploy DB backup | **982 MB** → `/home/yogi/crm-backups/crm-predeploy-…sql` |
| pull merged main | host `9ff21cb → c9ddcbd`, 25 migration files present |
| apply migrations 012–026 | **15/15 applied** |
| verify schema **before** restart | **15/15 tables**, 3 funnel pipelines seeded (13/6/5 stages) |
| restart | **only `denchclaw-crm`** — the other 6 pm2 apps stayed at `restarts=0` |
| verify **authenticated** | `/api/crm/contacts` → **200, 30,612 contacts** |
| deploy the frontend | `/var/www/crm/index.html` was from **4 July** (76 KB) — replaced with the built UI (136 KB), backed up first |

### Two things that would have made this deploy silently useless

1. **Migration 013 failed on real data.** It adds a FK `contacts.company_id → tenants`, and live
   data held two company_ids with no tenant row: `co_a_1782214773238` (16 contacts) and `cp4_co`
   (1) — leftover **test residue** in the staging DB. Every test DB I had ever used was empty, so
   this could not have surfaced before. **I did not delete production rows to make a migration
   pass**: both were provisioned as `status='archived', plan='test'` tenants, so the FK is
   satisfied, the 17 rows are untouched, and they are visibly marked as not-real. Reversible.
2. **The served UI was a month stale.** nginx serves `/crm/` from `/var/www/crm/`, not from the
   repo — so migrating and restarting would have left the operator looking at the **4 July**
   dashboard and concluding the work never shipped.

## 3. `claude login` — NOT DONE, and I cannot do it

    TTY on stdin: NO
    credentials file: absent
    `claude login` → API Error (no interactive OAuth prompt is reachable)

It needs an interactive browser OAuth flow. This is the one item that genuinely requires the
operator. Everything else is finished.

## Verification

**Staging, read-only against the DEPLOYED backend — 15/0.** All 8 tabs render on live data,
**22,888 real contact emails** rendered, the deployed backend reports the seeded funnel stages
(13/6/5), no pageerrors, no 4xx, no 5xx. Deliberately read-only: the shim blocked every non-GET
so a probe could not write into 30,612 live contacts.

**Interactive at the deployed commit against a scratch DB — 24/0.** Buttons, generations and every
channel format:

- `#new-contact` → modal → **`POST /contacts` 201**, count incremented, modal closed.
- Composer offers **Reply | Note | Templates**; **"Draft with AI" produced a real draft (0→179 chars)**.
- **Content formats correct per channel**: email 18 templates (**18/18 with a subject**), sms 2 and
  whatsapp 2 (**0 subjects — correct**), linkedin 5 (**exactly 1 subject — the InMail step**, which
  is right: `unipile-send` posts `{subject, inmail:true}`). Every template has a non-empty body.
- **`#ib-chan` (compose) = email, linkedin, whatsapp, sms — no `ai_call`**, while **`#ib-channel`
  (filter) includes `ai_call`.** That is CP-Z's *sendable ≠ recordable* rule visible in the UI.
- Stage chip menu offers legal targets only: `no_show_followup_2, scheduled_call, disqualified`.
- No pageerrors, no dialogs, no 5xx.

## Five probe defects of mine, none of them product bugs

1. Asserted pipeline **stage labels** against the list view, which shows pipeline **names** — the
   same whole-page-text mistake I made at CP-I.
2. Assumed "LinkedIn ⇒ no subject" and failed a **correct** design: InMail has one.
3. Polluted my own template check by leaving a probe-created template behind, turning 1/5 into 2/6.
4. Grabbed the **contacts source filter** instead of the composer's channel picker, making the
   `ai_call` check vacuous.
5. Filled the new-contact form with **unscoped** selectors, so the modal fields stayed empty and
   "the button doesn't work" was mine. Scoped to `#modal`, it creates a contact first time.
