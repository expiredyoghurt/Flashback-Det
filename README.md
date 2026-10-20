# Flashback Detectives v1.9

Branching-story practice for P3/4 pupils: 10 stories (4 embedded, 4 linked, 2 classical) plus a sorting game. See CHANGELOG.md.
Cloudflare Worker + D1 database + static pages (`public/`). Pupils log in with a username and PIN. Teachers use `/teacher.html`.

## Files
- `public/index.html`: story selector, login, all three stories
- `public/notes.html`: notes on the three flashback types
- `public/teacher.html`: teacher dashboard
- `src/worker.js`: API and server-side scoring
- `src/stories.json`: ALL story content, feedback, points, hints and the sorting extracts (edit this to change or add stories)
- `schema.sql`: D1 tables (safe to re-run)
- `.github/workflows/deploy.yml`: auto-deploy on push to `main`

## Deploy via GitHub
1. Create a GitHub repo and push this folder to `main`.
2. In a terminal (once): `npx wrangler login`, then `npx wrangler d1 create flashback-db`. Copy the `database_id` into `wrangler.toml`, commit and push.
3. Create a Cloudflare API token (template **Edit Cloudflare Workers**, plus **D1: Edit**). In the GitHub repo go to Settings → Secrets and variables → Actions and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main` (or run the workflow manually). It creates the tables and deploys. The URL is `https://flashback-detectives.<your-subdomain>.workers.dev`.
5. **Set your own teacher login** (one time, after the first deploy):
   ```
   npx wrangler secret put admin_user
   npx wrangler secret put admin_password
   ```
   If these secrets are not set, the defaults are **admin123 / password123**. Change them before pupils use it.

## Teacher accounts
Sign in at `/teacher.html` with the super admin secrets (`admin_user` / `admin_password`). The **Teacher accounts** card creates teachers (username + password of 8+ characters), resets passwords and deletes accounts. Teachers sign in on the same page and can change their own password. Only the super admin can manage teachers. In the same card, type a teacher's classes (e.g. `4A, 4B`) and press **Save classes**. Teachers only see those classes, and a teacher with no classes sees no pupils. Pupils with no class are visible to the super admin only. After deploying v1.4 the workflow re-runs `schema.sql`, which adds the new `teachers` table.

## Skills, XP and at-risk flags
Everything is rule-based and automatic, so no marking is needed. The rules and numbers are listed in CHANGELOG.md (v1.6). To change thresholds, edit `RANKS`, the XP values in `src/worker.js` (search for `xp_log`) and the flag rules in the `/api/admin/summary` handler. To tag a new story's steps with skills, add `"k":"<skill>"` to each node in `src/stories.json`.

## Writing quick check
`src/checker.js` holds the rules (patterns for triggers, time clues, "had" + past participle, and word-count targets: embedded memory 12-70 words, classical 50+, linked 40+). It is deliberately simple and can miss creative phrasing, so pupils see it as a guide. Change the numbers in `LEN` or the patterns, then redeploy. Writing frames and reflection nudges are defined per flashback type in `src/stories.json` (`frame`, `nudge`).

## AI helper (optional, off by default)
1. Workers AI: already bound in `wrangler.toml` (`[ai]`). If the GitHub deploy complains about the AI binding, add the Workers AI permission to your Cloudflare API token.
2. Grok and Gemini (optional): `npx wrangler secret put grok_api_key` and `npx wrangler secret put gemini_api_key`. With fewer providers the helper still works (a single provider decides alone).
3. Sign in as the super admin and tick "Turn on the AI helper for pupils" on the dashboard.
Defaults: model `@cf/meta/llama-3.1-8b-instruct` (Workers AI), `grok-4.7`, `gemini-3.8-flash`. Model names change often, so if a provider starts failing, set `WORKERS_AI_MODEL`, `GROK_MODEL` or `GEMINI_MODEL` as Worker variables. A failing provider simply does not vote.
**Privacy:** when the helper is on, the box text relevant to the disputed rule (no names, no class) is sent to those providers. Check your school's data policy and each provider's data terms before turning it on, and consider telling parents. Prompts tell the models to ignore instructions inside pupil text, and a majority vote limits the effect of any single wrong or manipulated answer, but AI can still be wrong, which is why the teacher can re-attempt.
`AI_MOCK` (e.g. `workers=1,grok=0`) is a test-only variable that fakes provider answers. Never set it in production.

## Transfer tasks
Content is in `src/transfer.json`. A **picture prompt** has `ic` (emoji picture), `see`, `plot`, `type`, `why` and three `plan` options (exactly one with `"tag":"ok"`; other tags: describe, unrelated, toolong, rushed, wrongtype, with their feedback under `tags`). A **flawed flashback** has the story `type`, `parts` (one string per writing-frame box, see `frame` in `stories.json`), `edit` (index of the flawed box), four `diag` options (one `"ok":1`), `targets` (quick-check rule ids the fix must pass) and a `model` fix. Check that the original fails a target and the model passes every target before you add one: the rules are in `src/checker.js`.

## Local test
`npx wrangler d1 execute DB --local --file=schema.sql && npx wrangler dev`

## Teacher guide
- Open `/teacher.html` and log in.
- **Pupils:** stories finished (of 3), points, try-agains, last active. Reset a forgotten PIN here.
- **Where pupils struggle:** each step ranked by the share of non-best choices. Steps near the top need re-teaching (e.g. "len" in The Lost Puppy shows who picks over-long flashbacks).
- **Reflections:** open each completed story to read pupils' written answers.
- In class: pupils read the notes, play one story per lesson, then discuss the reflection answers.

## Notes
- Scoring is done on the server. Pupil PINs are hashed, sessions expire, and repeated bad logins are locked out for 10 minutes.
- Teacher dashboard: filter by class, click a pupil for their choices, comment on writing, assign stories, bulk-create accounts (PINs are shown once), export CSV.
- Adding a story: copy an entry in `src/stories.json` (each node needs at least one option with `"r":"g"`; `"n"` is the next node, `"sum"` ends the story; `"rt":1` forces a retry). Then redeploy.
