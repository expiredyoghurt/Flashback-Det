# Changelog
## v1.9: transfer tasks
- 🖼️ Picture Prompt Challenge (9 prompts: 3 embedded, 3 classical, 3 linked). Pupils read a picture (emoji scene) and a plot idea, choose which kind of flashback fits, then choose the best plan (three options with different faults: describing instead of explaining, unrelated memory, too long, too thin, wrong type). Scored on the server with an explanation for every answer
- 🔧 Fix the Flashback (7 flawed flashbacks: too long, describes instead of explains, stuck in the past, memory too small, no time clue or "had", missing link, tells instead of shows). Step 1: diagnose the main problem. Step 2: rewrite the flawed box. The rewrite is checked by the same rule-based quick check, only on the rules that task targets (the text must also really change). After a pass or 3 attempts the pupil sees a model fix
- XP: 5 per newly correct step in a picture prompt, 3 for a first correct diagnosis, 15 for a first successful fix (no XP for repeats). Two new skills (Choosing the Right Type, Fixing Flawed Flashbacks) feed the skill meters, heatmap and "Try next" suggestion
- Teachers: new "Transfer tasks" table with right-type and best-plan rates, the type pupils most often confuse each prompt with, and diagnosis, fix and attempt rates for each flawed flashback (own classes only)
- Not built (skipped on request): Daily 3, tiers, streaks, class quests, avatars, sound
## v1.8: limited AI second opinion (off by default)
- Pupils: after a quick check, a rule marked as missing shows "🤔 I think I did this: ask the AI helper", but only for rules where wording varies (trigger, time clue, simple past, explains why, return, link, acting differently). Never for "had" or length. The AI reads only the box(es) that rule needs. Workers AI, Grok and Gemini each answer and the majority decides (if the answers tie or too few come back, the pupil is told the helpers could not agree). If the AI agrees, that rule counts for that exact text (editing the text cancels it) and earns the usual writing XP
- Limits: super-admin on/off switch (default OFF), a daily cap per pupil (default 5, max 20), repeated identical questions are answered from the stored result
- Teachers: new "AI checks pupils asked for" table with each provider's vote and a "Reattempt AI check" button (Workers AI + Grok, up to 3 times per record; if both say present, the stored quick-check result for that writing is updated). Teachers only see and re-check their own classes. Only the super admin can turn the AI helper on/off
- New secrets (optional): `grok_api_key`, `gemini_api_key`. Workers AI uses a binding, no key. Optional vars: WORKERS_AI_MODEL, GROK_MODEL, GROK_BASE_URL, GEMINI_MODEL
- The Daily 3 drills, tiers and streaks from the plan move to v1.9
## v1.7: writing frame, quick check and reflection nudges
- "Your turn" is now a writing frame with a box per part of the story (embedded: before / flashback / back in the present; classical: opening / memory / return; linked: trigger / memory / similar situation / acting differently)
- "Quick check" gives instant rule-based feedback (no AI) as often as the pupil likes: trigger, time clue, memory starts with "had", then simple past, length, explains why (embedded), return, link and acting differently (linked). It is a guide, not a grade: it never blocks anything and does not change the story score. The submitted version earns writing XP: 5 for 10+ words plus 2 per passed check (max 10)
- Reflection nudges: as pupils type, a short prompt suggests adding a reason ("because"), a comparison ("but"/"whereas"), or an action for next time, and asks for at least 6 words
- Teachers see each piece with its quick-check result, and a "Common gaps in pupil writing" table ranking the rules pupils miss most (for their own classes)
- Thresholds (memory length in words, wording patterns) are at the top of `src/checker.js`
## v1.6: skills, XP and at-risk flags
- Every story step is tagged with a skill (Openings & Tension, Triggers, Placement, Length & Scope, Explain-Don't-Describe, Linking Past & Present, Returning). Tags live in `src/stories.json` (`"k"` on each node; names in `"skills"`)
- Skill mastery = share of first tries correct over a pupil's last 20 first tries in that skill. Pupils see skill meters and a "Try next" recommendation (the story that practises their weakest skill). Teachers see a class skill heatmap and per-pupil meters
- XP and ranks (Rookie 0, Sleuth 100, Inspector 350, Chief 800 XP). Per step: 10 XP for a correct first try, 5 for correct after a retry, 2 for effort. Completing a story is 25 XP (+15 perfect, +10 for 10+ words of writing, +2 per reflection answer of 6+ words, max 10). From a pupil's 3rd completion of the same story, step and completion XP are halved. The sorting game gives 3 XP per point above the pupil's previous best
- At-risk flags (shown to teachers within their own classes): under 70% first-try accuracy over the last 50 first tries (needs 50+); under 50% in a skill after 10+ attempts; 3+ retries on one step in the last 14 days; no activity for 14+ days; account over 7 days old with no activity. Filter the pupil list to flagged pupils; flags and XP are included in the CSV
- Pupils who played before v1.6 get skill history and starting XP built from their old choices the first time they sign in or a teacher opens the dashboard (starting XP is an estimate)
## v1.5
- Class-based teacher rights. The super admin gives each teacher a list of classes (Teacher accounts card, "Save classes"). A teacher can only see and manage pupils, writing, reflections, statistics, assignments and class lists for their own classes. Class names are matched ignoring case and spaces (4a = 4A)
- **After upgrading, existing teachers see nothing until the super admin assigns their classes.** Pupils with no class are visible to the super admin only
- Reflection questions now have scaffolding: tap-to-insert sentence starters and an "Ideas you could write about" list for every question, for each of the three flashback types
## v1.4
- Fixed: the assembled story now puts the flashback where the pupil placed it (start, at the moment, later, or end), shown in a highlighted "💭 Flashback" block
- Multiple teacher accounts. The super admin (the `admin_user` / `admin_password` Worker secrets) signs in on /teacher.html, then creates, resets and deletes teacher accounts from the dashboard. Teachers can change their own password. Teacher passwords are stored with PBKDF2 and salt; teachers cannot manage other teachers
- Teachers currently see all classes and pupils
## v1.3: 10 stories
+4 stories: The Wallet and The Recital (embedded), The Hard Sum and The Torn Card (linked). Totals: 4 embedded, 4 linked, 2 classical.
## v1.2
- "Which flashback is it?" sorting activity (9 extracts, scored on the server)
- Story map bar on every story and summary (memory segment highlighted)
- Teacher: class filter, pupil drill-down, delete pupil, bulk class list with generated PINs, CSV export, assign stories to a class (pinned for those pupils)
- Hardening: sessions expire (pupil 12h, teacher 4h), login lockout (5 bad PINs per name, 40 per IP, 8 for teacher login per 10 minutes), read-aloud buttons, easy-read font, bigger text, 48px tap targets
## v1.1
- +3 stories: The Treehouse (classical), The Spilled Paint (linked), The Last Lap (embedded)
- "Your turn" writing step with a self-check list; teacher can comment and pupils see the comment
- Options shuffled, hints, half points after a retry
- Story content moved to `src/stories.json`; answers and points never reach the browser until a choice is made; scoring on the server
- Full badge set: First Steps, Path Explorer, Strategic Placer, Content Master, Length Expert, Flashback Architect, Persistent Learner
- Fixed: "end"/"no flashback" paths in The Lost Puppy no longer get stuck
## v1.0
3 stories, login, basic dashboard.
