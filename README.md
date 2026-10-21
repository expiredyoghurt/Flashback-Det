# Flashback Detectives v2.0

Branching-story practice for P3/4 pupils: 10 stories (4 embedded, 4 linked, 2 classical) plus a sorting game. See CHANGELOG.md.
Cloudflare Worker + D1 database + static pages (`public/`). Pupils log in with their **username and a class code** (no passwords or PINs), or play as a guest. Teachers use `/teacher.html`.

## Files
- `public/index.html`: story selector, login, all three stories
- `public/notes.html`: notes on the three flashback types
- `public/teacher.html`: teacher dashboard
- `src/worker.js`: API and server-side scoring
- `src/login.js`: sign-in (class codes, signed tokens, guests, teachers) and the class and pupil tools
- `src/migrate.js`: the one-off v1.9 → v2.0 database upgrade (runs by itself; `migrate-v2.0.sql` is the same thing as a file)
- `src/stories.json`: ALL story content, feedback, points, hints and the sorting extracts (edit this to change or add stories)
- `schema.sql`: D1 tables (safe to re-run)
- `test/`: `npm test` (35 tests: sign-in, classes, migration, and the two pages in a simulated browser)
- `.github/workflows/deploy.yml`: auto-deploy on push to `main`

## Deploy via GitHub
1. Create a GitHub repo and push this folder to `main`.
2. In a terminal (once): `npx wrangler login`, then `npx wrangler d1 create flashback-db`. Copy the `database_id` into `wrangler.toml`, commit and push.
3. Create a Cloudflare API token (template **Edit Cloudflare Workers**, plus **D1: Edit**). In the GitHub repo go to Settings → Secrets and variables → Actions and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main` (or run the workflow manually). It creates the tables and deploys. The URL is `https://flashback-detectives.<your-subdomain>.workers.dev`.
5. **Set your own teacher login** (one time, after the first deploy):
   ```
   npx wrangler secret put teacher_user
   npx wrangler secret put teacher_password
   ```
   (`admin_user` / `admin_password`, the v1.9 names, still work. Optionally set a `session_secret` secret too: without it, changing the teacher password signs every pupil out once.) **There is no default login any more**: until one of these pairs is set, nobody can log in as a teacher, and pupils see "This app is not set up yet".

## Classes and pupil log-in (v2.0)
Pupils sign in with **their username and their class's 6-character code** (for example `K7M2QX`). There are no passwords, no PINs and no self-registration: a teacher adds the pupils. Everyone logs in the same way, so the teacher can print a card for each pupil. **Play as a guest** lets anyone try every story without a class; guest work is kept for 30 days (a daily clean-up deletes it), only the super admin sees it, and the AI helper is never available to guests.
- Codes avoid 0/O/1/I/L. Typing is forgiving (capitals, spaces, dashes). Every failed pupil log-in gives the same message, so nobody can find out which classes or usernames exist. Log-ins are limited per IP address.
- A sign-in lasts 12 hours (teachers 8) and ends when the browser tab closes. A **new class code** stops the old code working, and can also sign the whole class out at once. **Archiving** a class does that and blocks log-in until you restore it.
- Usernames are lowercase letters, numbers, dots, dashes or underscores (2-24) and are unique within a class (two classes can each have a `sam`).
- **Teacher dashboard → Classes:** create, rename, archive, new code, delete (type the name to confirm); paste a list of names (one per line, optionally `Name, username`), check it, edit usernames, then add; edit a pupil, move them to another class, reset their progress or delete them; **print login cards**.
- Teachers can create classes (they get them automatically); the super admin can switch that off. Everything else about teacher accounts is as before.

## Teacher accounts
Sign in at `/teacher.html` with the super admin secrets (`teacher_user` / `teacher_password`, or the older `admin_user` / `admin_password`). The **Teacher accounts** card creates teachers (username + password of 8+ characters), resets passwords and deletes accounts. Teachers sign in on the same page and can change their own password. Only the super admin can manage teachers. In the same card, tick the classes each teacher can manage and press **Save classes**. Teachers only see those classes, and a teacher with no classes sees no pupils. Guests (no class) are visible to the super admin only. A teacher's sign-in stops working when their password is changed or reset, or the account is deleted.

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

## Upgrading from v1.9 (back up first)
The upgrade needs nothing but a normal deploy:
```
npx wrangler d1 export flashback-db --remote --output=backup-before-v2.0.sql   # optional but wise
```
then push to `main`. On the first request after the deploy the Worker converts the database in **one atomic step** (if anything went wrong nothing would change): every class name becomes a class with its own code, every pupil **keeps their id**, so all stories, writing, XP and badges stay theirs, usernames are tidied to the new rules (lowercase, no spaces; one that can't be made valid, or that clashes, becomes `pupil<id>`, and you can rename it in the Classes panel), pupils with no class go into a class called **Unassigned**, and teacher class rights and assigned stories move to the new classes. PIN hashes and old sessions are deleted, so everyone logs in again once. Then: open **Classes**, give each class's code to its pupils, and print the cards. `migrate-v2.0.sql` is the same upgrade as a file, if you prefer to read or run it yourself.
Two settings arrive in `wrangler.toml`: the sign-in rate limits (`RL_LOGIN`, `RL_GUEST`, each needs a namespace id that is unique in your Cloudflare account; change `4301` / `4302` if they clash) and the daily guest clean-up cron. **Set the `teacher_user` / `teacher_password` secrets if you relied on the old default login.**

## Local test
`npm test` runs the tests (`npm i -D jsdom` first to include the two pages' browser tests).
`npx wrangler d1 execute DB --local --file=schema.sql && npx wrangler dev`

## Teacher guide
- Open `/teacher.html` and log in.
- **Pupils:** stories finished (of 3), points, try-agains, last active. A pupil who has forgotten their username: it is in the Classes panel, or print their card again.
- **Where pupils struggle:** each step ranked by the share of non-best choices. Steps near the top need re-teaching (e.g. "len" in The Lost Puppy shows who picks over-long flashbacks).
- **Reflections:** open each completed story to read pupils' written answers.
- In class: pupils read the notes, play one story per lesson, then discuss the reflection answers.

## Notes
- Scoring is done on the server. Sign-ins are signed tokens that expire, and repeated bad teacher logins are locked out for 10 minutes.
- Teacher dashboard: filter by class, click a pupil for their choices, comment on writing, assign stories to a class, manage classes and pupils, export CSV.
- Adding a story: copy an entry in `src/stories.json` (each node needs at least one option with `"r":"g"`; `"n"` is the next node, `"sum"` ends the story; `"rt":1` forces a retry). Then redeploy.
