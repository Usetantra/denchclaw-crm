-- DenchClaw CRM — Migration 011: single-tenant consolidation + normalized company entity
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/011_company_normalization.sql
--
-- Three things, in one transaction:
--   1. Consolidate all real data under the single canonical tenant 'tantra'
--      (folds the legacy 'growthclub' + 'dev_company' ids). Test-tenant residue
--      (co_a_*, cp4_co) is intentionally left untouched — it is invisible to the
--      tantra-scoped UI and re-created fresh by the contract suite.
--   2. Normalize the company<->contact/deal link into a real FK
--      (contacts.company_ref_id, deals.company_ref_id -> companies.id).
--   3. Backfill company rows for real accounts (>=2 contacts share a normalized
--      name), skipping a small blocklist of obvious scrape noise, then link
--      contacts and deals to them.
--
-- Two tables carry a UNIQUE that includes company_id and therefore cannot be
-- blind-folded (would abort on a key collision): campaign_event_rollups
-- (company_id,campaign_id,channel,segment,day) and companies (company_id,
-- lower(name)). Both are handled collision-safe below.

BEGIN;

-- ── 1. Consolidate legacy tenants → 'tantra' ──────────────────────────────────
-- Tables whose uniqueness is keyed on contact_id / provider_message_id / PK id
-- (not company_id) fold safely with a blind UPDATE:
UPDATE contacts               SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE contact_activity       SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE deals                  SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE conversations          SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE messages               SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE campaign_events        SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');
UPDATE prospect_inbox         SET company_id='tantra' WHERE company_id IN ('growthclub','dev_company');

-- campaign_event_rollups: UNIQUE(company_id,campaign_id,channel,segment,day) —
-- aggregate legacy + existing 'tantra' counters into the tantra row, then drop
-- the legacy rows. (Summing includes any existing tantra row, so DO UPDATE sets
-- the full merged total; re-run is a no-op once legacy rows are gone.)
INSERT INTO campaign_event_rollups
  (company_id,campaign_id,channel,segment,day,sends,delivers,opens,clicks,replies,bounces,unsubs,mql_count,updated_at)
SELECT 'tantra',campaign_id,channel,segment,day,
       sum(sends),sum(delivers),sum(opens),sum(clicks),sum(replies),sum(bounces),sum(unsubs),sum(mql_count),now()
FROM campaign_event_rollups
WHERE company_id IN ('growthclub','dev_company','tantra')
GROUP BY campaign_id,channel,segment,day
ON CONFLICT (company_id,campaign_id,channel,segment,day) DO UPDATE SET
  sends=EXCLUDED.sends, delivers=EXCLUDED.delivers, opens=EXCLUDED.opens, clicks=EXCLUDED.clicks,
  replies=EXCLUDED.replies, bounces=EXCLUDED.bounces, unsubs=EXCLUDED.unsubs, mql_count=EXCLUDED.mql_count,
  updated_at=now();
DELETE FROM campaign_event_rollups WHERE company_id IN ('growthclub','dev_company');

-- companies: UNIQUE(company_id,lower(name)) — only fold a legacy row when no
-- 'tantra' row already owns that name (collision-safe; inert while empty).
UPDATE companies SET company_id='tantra'
 WHERE company_id IN ('growthclub','dev_company')
   AND NOT EXISTS (SELECT 1 FROM companies t WHERE t.company_id='tantra' AND lower(t.name)=lower(companies.name));

-- Pipeline configs: only company-scoped rows (NULL globals untouched); skip any
-- that would collide with an existing 'tantra' row on the unique (company_id,key).
UPDATE crm_pipeline_configs SET company_id='tantra'
 WHERE company_id IN ('growthclub','dev_company')
   AND NOT EXISTS (SELECT 1 FROM crm_pipeline_configs t
                    WHERE t.company_id='tantra' AND t.key = crm_pipeline_configs.key);

-- ── 2. Normalized company FK ──────────────────────────────────────────────────
-- Unique index doubles as the ON CONFLICT target for idempotent upserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_tenant_lname ON companies (company_id, lower(name));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_ref_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE deals    ADD COLUMN IF NOT EXISTS company_ref_id UUID REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_company_ref ON contacts (company_ref_id);
CREATE INDEX IF NOT EXISTS idx_deals_company_ref    ON deals (company_ref_id);

-- ── 3. Backfill real accounts (>=2 contacts, minus scrape-noise blocklist) ─────
WITH norm AS (
  SELECT company_id,
         lower(btrim(company_name)) AS lname,
         btrim(company_name)        AS disp
  FROM contacts
  WHERE deleted_at IS NULL
    AND company_name IS NOT NULL
    AND btrim(company_name) <> ''
    AND lower(btrim(company_name)) NOT IN (
      'home','home page','homepage','page','blog','growth','growthclub','tantra',
      'ai','full','merge','about','contact','contact us','login','log in','sign up',
      'signup','product','products','pricing','features','n/a','na','none','null',
      'unknown','test','demo','index','dashboard','portal','careers','support'
    )
),
agg AS (
  SELECT company_id, lname,
         count(*)                                  AS c,
         mode() WITHIN GROUP (ORDER BY disp)       AS display_name
  FROM norm
  GROUP BY company_id, lname
  HAVING count(*) >= 2
)
INSERT INTO companies (company_id, name)
SELECT company_id, display_name FROM agg
ON CONFLICT (company_id, lower(name)) DO NOTHING;

-- 3b. Link contacts → their company by normalized name. Only company rows that
-- actually exist can match, so the blocklist is enforced transitively; the
-- explicit guard is defence-in-depth against any pre-existing bad row.
UPDATE contacts ct SET company_ref_id = co.id
FROM companies co
WHERE co.company_id = ct.company_id
  AND lower(co.name) = lower(btrim(ct.company_name))
  AND ct.deleted_at IS NULL
  AND ct.company_ref_id IS DISTINCT FROM co.id;

-- 3c. Link deals → company via their linked contact (same-tenant guard so a
-- cross-tenant contact reference can never attach a foreign company).
UPDATE deals d SET company_ref_id = ct.company_ref_id
FROM contacts ct
WHERE d.contact_id = ct.id
  AND d.company_id = ct.company_id
  AND ct.company_ref_id IS NOT NULL
  AND d.company_ref_id IS DISTINCT FROM ct.company_ref_id;

COMMIT;
