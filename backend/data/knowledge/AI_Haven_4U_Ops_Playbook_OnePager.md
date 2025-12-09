AI Haven 4U Ops Playbook (One‑Pager)
**Purpose:** keep AI Haven 4U safe, helpful, and non‑dependency‑forming after launch.
## A) Daily On‑Call Checklist (15–30 min)
1. Review dashboards:
   - taboo attempts & refusal rates
   - near‑miss output blocks (top clusters)
   - consent checkpoint firing + compliance
   - crisis pivots + sampled correctness
   - delusion pivots + sampled correctness
   - dependency strong signals + time‑spikes
2. Triage:
   - **Any taboo slip / crisis misroute / delusion reinforcement?** → P0
   - **Near‑miss spike or new jailbreak cluster?** → P1
   - **Quality dip in canary vs baseline?** → P1/P2
3. Actions:
   - P0 → freeze explicit + rollback model + open incident doc
   - P1 → create ticket, add sample prompts to red‑team queue
   - P2 → monitor; schedule next sprint fix
## B) Weekly Safety + Quality Cadence
- Run full red‑team pack
- 300‑session calibrated human audit
- Add all fails/near‑miss clusters to regression within 24h
- Publish “Safety & Quality Weekly” memo:
  - incidents
  - top risks
  - fixes shipped
  - recommended gate changes
## C) Monthly Improvement Cadence
- Outcomes review:
  - loneliness delta, felt‑heard, comfort, return intent
- Router calibration
- Prompt + skill updates
- Canary rollout of safe changes
## D) Quarterly Program
- Dependency audit (500‑session sample of high‑usage users)
- Add 1–2 new loneliness skills
- Tuning refresh if quality plateaued
- Policy/spec review with Safety + Legal
## E) Incident Playbook (P0)
1. Freeze explicit mode (kill switch)
2. Roll back to last safe baseline
3. Scope + reproduce
4. Patch smallest layer first
5. Add regression in 24h
6. Post‑mortem + prevention updates
**Non‑negotiable:** safety invariants never regress.
