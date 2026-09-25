# KV-backed settings (`/api/_meta/settings`)

Settings are a **single free-form JSON object** stored in a Cloudflare KV namespace
under the key `settings:v1` (binding name `SETTINGS`). This is the config bucket for
stuff that shouldn't require redeploying a Worker or a D1 table — site config,
navigation, UI copy, feature toggles, third-party keys for frontends, etc.

## API

- `GET /api/_meta/settings` → `{ "data": { … } }` (the whole blob).
- `PUT /api/_meta/settings` with a JSON **object** body → merges shallowly over the
  current blob and persists; response is the merged result.

```bash
# login (once)
KEY='dev-admin-key-change-me'
TOKEN=$(curl -s -X POST http://localhost:8789/api/_auth/token \
  -H 'content-type: application/json' -d "{\"key\":\"$KEY\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

# read
curl -s http://localhost:8789/api/_meta/settings -H "authorization: Bearer $TOKEN"

# write/merge
curl -s -X PUT http://localhost:8789/api/_meta/settings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"site":{"name":"Acme"}}'
```

Both endpoints require a JWT by default (they are NOT public even with
`PUBLIC_GETS=true`, which only opens GET on `/{collection}` records). Frontends that
call settings from the edge pass their `CORE_API_TOKEN` like any other request.

## Recommended shape

The seed writes the canonical example; the public site reads the `site.*` keys:

```jsonc
{
  "localization": {
    "languages": ["en", "id"]
  },
  "site": {
    "name": "Hamolus",
    "tagline": "A headless-CMS / dynamic data platform on Cloudflare Workers.",
    "navigation": [
      { "label": "Home", "href": "/" },
      { "label": "Posts", "href": "/posts" },
      { "label": "Categories", "href": "/categories" }
    ]
  }
  // add anything else you like:
  // "social": { "github": "…", "twitter": "…" },
  // "announcement": { "enabled": true, "text": "…" }
}
```

Because the blob is free-form, `PUT` never validates a fixed schema — it only requires
the body to be a JSON object. The console's **Settings** page edits it as JSON.

## Localization

When `localization.languages` is set (an array of language codes like `["en", "id"]`),
fields marked with `localized: true` in their collection definition will store values
as a JSON object keyed by language code:

```jsonc
// stored value for a localized text field
{ "en": "Hello world", "id": "Halo dunia" }
```

The console automatically renders language tabs for localized fields, allowing editors
to input values for each configured language. The core API validates that localized
values match the configured language structure.

## Consumption in the site

- `src/lib/api.ts` → `getSettings()` returns the blob (or `{}` on failure).
- `src/layouts/Base.astro` → `site.name` (brand/title/footer), `site.navigation`
  (header links; falls back to listing all collections if absent).
- `src/pages/index.astro` → `site.name` + `site.tagline` for the hero.

## Production notes

- Reveal the namespace id (`wrangler kv namespace list`) and set it in
  `wrangler.jsonc` under `kv_namespaces`.
- The blob is readable by any token holder and by the site at runtime — don't store
  server secrets that belong in `wrangler secret`.