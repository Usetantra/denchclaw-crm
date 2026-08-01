# CP-Y3 — `automated` fails OPEN on a non-boolean. Coerce it safely.

Found while sweeping CP-Y2. **Low severity, small fix, same failure shape as CP-Y.**

    PATCH /deals/:id {stage:'won', automated:"true"}  →  200, deal moved to `won`

All three gate sites read `req.body.automated === true` (crm.js:750, 950, 1116). The **string**
`"true"` is not `true`, so the caller is treated as a **human** and the mode gate never fires.
An unexpected value opens the gate instead of closing it — exactly the shape of the original bug.

**Reachability is limited and I want that on the record:** every in-repo caller sends a real
boolean, so nothing ships broken today. It matters because the internal API is called over HTTP
by the outreach and nurturing engines, and a loosely-typed or form-encoded client sending `"true"`
would silently acquire human authority over `won`/`lost`.

## Fix

One shared helper, used at all three sites — do not hand-inline it a third time:

    // Anything that is not an explicit, recognisable "no" counts as automated.
    // The unsafe direction is treating a robot as a human, so ambiguity resolves
    // to automated.
    function isAutomatedRequest(body) {
      const v = body?.automated;
      if (v === undefined || v === null) return false;   // absent = a human at the UI
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      return !(s === 'false' || s === '0' || s === '');   // "true", "1", anything else ⇒ automated
    }

Note the asymmetry is deliberate: **absent** means human (the UI sends nothing), but **present
and unrecognisable** means automated. A caller that bothered to send the field is a program.

## Acceptance criteria

- C1 `automated:"true"`, `automated:1`, `automated:"TRUE"` are all refused (403) on a manual stage.
- C2 `automated:false`, `automated:"false"`, `automated:"0"` still behave as a human (200).
- C3 **POSITIVE CONTROL** — a request with **no** `automated` field is still a human (200). The UI
  sends none, and breaking that would break the product for every real user.
- C4 automated writes to a declared-`auto` stage still succeed.
- C5 full suite green.

Receipt to `.loop/receipts/CP-Y3-automated-coercion.md`.
