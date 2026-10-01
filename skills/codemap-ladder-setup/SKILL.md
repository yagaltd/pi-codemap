---
name: codemap-ladder-setup
description: Set up the pi-codemap model-tier ladder (~/.config/pi-codemap/models.json). Scan the user's configured providers and API credentials, list the models each subscription actually offers, and propose a cheap-to-frontier tier ladder for codemap routing. Use when the user asks to set up, fix, extend, or review codemap model routing, the tier ladder, models.json, or codemap/auto.
---

# codemap tier-ladder setup

Goal: a human-curated `~/.config/pi-codemap/models.json` with 2-3 tiers,
cheapest first, that the `codemap/auto` virtual model routes between.

## Schema

```json
{
  "tiers": {
    "low":      { "model": "zai/glm-5.3-flash", "profile": "Mechanical edits, renames, formatting" },
    "standard": { "model": "zai/glm-5.3",       "profile": "Ordinary features, fixes, reviews" },
    "frontier": { "model": "anthropic/claude-sonnet-4-5", "profile": "Architecture, hard debugging, security" }
  }
}
```

Rules: 2-3 tiers, cheapest FIRST; `model` is `provider/id` and both must exist
in pi's catalog; `profile` is one line of human-written capability description
(it becomes the classifier's criteria). Labels are free-form.

## Procedure

1. **Detect credentials** — check environment (`ZAI_API_KEY`/`ZHIPU_API_KEY`,
   `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and
   `~/.pi/agent/auth.json` (never print secret values). Only providers with
   credentials are candidates.
2. **List models per provider**:
   - z.ai: `GET https://api.z.ai/api/paas/v4/models` with the key
   - OpenRouter: `GET https://openrouter.ai/api/v1/models` (hundreds — filter
     to established coding models, cap the shortlist at ~10, prefer models the
     user's plan actually covers)
   - Anthropic / OpenAI: known catalogs; no listing call needed.
   Never invent model ids — verify each against the provider's list.
3. **Propose a ladder** — present a table (label, provider/model, profile,
   rough price tier) and let the user edit it. Cheapest first. 2 tiers is a
   valid ladder; 3 is the max that helps.
4. **On confirmation, write the file**:
   `~/.config/pi-codemap/models.json` (create dirs; JSON, no secrets inside).
5. **Activate**: tell the user to select `codemap/auto` in `/model`, then run
   `/codemap:status` — it should show `classifier codemap/auto`-routed turns
   and the tier labels. Routing only applies while `codemap/auto` is selected.

## Notes

- Routing down is confidence-gated upstream: only tasks the classifier deems
  mechanical get the cheap tier, and the verifier logs (never gates) quality.
- Kill switch: delete models.json, or set `CODEMAP_ROUTE=off`.
