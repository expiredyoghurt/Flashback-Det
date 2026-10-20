// Rule-based "quick check" for pupil writing. No AI: simple word and pattern rules, so it is a guide, not a grade.
// Tunable thresholds (words in the memory box):
export const LEN = { embedded: [12, 70], classical: [50, Infinity], linked: [40, Infinity] };
const IRR = new Set('been gone seen done made taken given known come run held told said found felt kept left lost met put read sat stood taught thought won written worn broken chosen fallen forgotten grown hidden ridden spoken stolen swum thrown woken brought bought caught built sent spent slept sung begun drunk eaten flown shown torn drawn driven become set let hit cut shut hurt cost got heard led paid shot sold struck swept swung understood'.split(' '));
const EXC = new Set(['then', 'often', 'even', 'open', 'garden', 'kitchen', 'children', 'chicken']);
const PAST = new RegExp('\\b(' + 'ran said took gave knew came held told found felt kept left lost met put read sat stood taught thought won wrote wore broke chose fell forgot grew hid rode spoke stole swam threw woke brought bought caught built sent spent slept sang began drank ate flew showed tore drew drove became got heard led paid shot sold struck swept swung understood was were went saw did'.split(' ').join('|') + ')\\b', 'i');
const TRIG = /\b(remind(?:ed|s)?|remember(?:ed|s)?|memory|memories|smell(?:ed|s)?|scent|sound|heard|hear|touch(?:ed)?|felt|feel|warm(?:th)?|bell|saw|stared|noticed|looked|pressed|tugged|brushed|whisper(?:ed)?|voice|familiar|knew|same|once|nervous|heart|trembl\w*|wobbl\w*|shak\w*|shook|froze|stomach|scared|afraid|worried|tight|knees|hands|tears|dry)\b/i;
const TIME = /\b(last (?:year|week|month|summer|winter|spring|autumn|night|time|term)|(?:a|one|two|three|four|five|six|\d+) (?:years?|months?|weeks?|days?) ago|years ago|long ago|once upon|one (?:day|summer|morning|evening|afternoon)|that day|the day|yesterday|as a (?:child|baby|toddler)|back then|years old|when (?:he|she|i|they|we) (?:was|were)|again)\b/i;
const EXPL = /\b(promis(?:e|ed)|taught|told|said|learn(?:ed|t)|because|so that|always|never|lesson|from then on|since then|that is why|meant|wished|hoped|reminded|“|")/i;
const LINK = /\b(just (?:as|like)|the same|like (?:before|then)|once again|again|similar|exactly|as (?:he|she|they) (?:once|had)|once)\b/i;
const ACT = /\b(walk(?:ed)?|went|step(?:ped)?|smil(?:e|ed)|said|asked|wav(?:e|ed)|took|pick(?:ed)?|tried|decid(?:e|ed)|ran|called|offered|shar(?:e|ed)|told|held|gave|hug(?:ged)?|knock(?:ed)?|open(?:ed)?|sat|joined|invited|apolog\w+|instead|this time|differently)\b/i;
const sents = t => String(t || '').trim().split(/(?<=[.!?…][”"’']?)\s+|\n+/).map(s => s.trim()).filter(Boolean);
export const words = t => (String(t || '').match(/[A-Za-z’']+/g) || []).length;
function pp(s) { const re = /\bhad(?:n['’]t)?\s+(?:not\s+|never\s+|always\s+|just\s+|already\s+|ever\s+|only\s+)?([a-z]+)/gi; let m; while ((m = re.exec(s))) { const w = m[1].toLowerCase(); if (IRR.has(w) || (w.length > 3 && !EXC.has(w) && /(ed|en|wn)$/.test(w))) return true; } return false; }
const sp = s => !pp(s) && (/\b[a-z]{3,}ed\b/i.test(s) || PAST.test(s));
export const LABELS = { trigger: 'Something in the present triggers the memory', time: 'A time clue shows we have gone back in time', had: 'The memory starts with “had”', past: 'After that, the memory moves to simple past', len: 'The memory is about the right length', explain: 'The memory explains why the character feels or acts this way', ret: 'You come back to the present', link: 'You show the present is like the memory', act: 'The character DOES something different at the end' };
const ORDER = { embedded: ['trigger', 'time', 'had', 'past', 'len', 'explain', 'ret'], classical: ['trigger', 'time', 'had', 'past', 'len', 'ret'], linked: ['trigger', 'time', 'had', 'past', 'len', 'link', 'act'] };
export function check(type, parts, frame) {
  const P = {}; frame.forEach((f, i) => { P[f.r] = String(parts[i] || '').trim(); });
  const mem = P.mem, ms = sents(mem), wm = words(mem), [lo, hi] = LEN[type] || [0, Infinity];
  const empty = (r, name) => !P[r] && `Write something in the “${name}” box first.`;
  const fl = r => (frame.find(f => f.r === r) || {}).l || r;
  const rules = {
    trigger: () => empty('pre', fl('pre')) || (TRIG.test(P.pre) ? '' : 'Show what in the present starts the memory: a sound, smell, touch, object or feeling.'),
    time: () => empty('mem', fl('mem')) || (TIME.test(P.pre + ' ' + ms.slice(0, 2).join(' ')) ? '' : 'Add a time clue such as “Last summer…” or “A year ago…”.'),
    had: () => empty('mem', fl('mem')) || (pp(ms.slice(0, 2).join(' ')) ? '' : 'Start the memory with “had”, for example: She had held the seat…'),
    past: () => (ms.length < 2 ? null : ms.slice(1).some(sp) ? '' : 'After the first sentences, switch to simple past (ran, laughed, said) so it is easy to read.'),
    len: () => empty('mem', fl('mem')) || (wm < lo ? (type === 'embedded' ? 'Add a little more detail (about 12+ words).' : `Tell more of the memory: this kind of flashback needs about ${lo}+ words with a beginning, a problem and a climax.`) : wm > hi ? 'Shorten it. An embedded flashback is only 1–2 short paragraphs.' : ''),
    explain: () => empty('mem', fl('mem')) || (EXPL.test(mem) ? '' : 'Say what the memory means: what the character promised, learned or was told.'),
    ret: () => empty('post', fl('post')) || (words(P.post) >= 6 && !pp(sents(P.post)[0] || '') ? '' : 'Write 1–2 sentences that bring the character back to the present (not still in the past).'),
    link: () => empty('link', fl('link')) || (LINK.test(P.link) ? '' : 'Show that now is like then. Try “just as…” or “the same…”.'),
    act: () => empty('act', fl('act')) || (words(P.act) >= 8 && ACT.test(P.act) ? '' : 'Show what the character DOES (walked over, said, picked up…), in at least one full sentence.')
  };
  const results = (ORDER[type] || []).map(id => { const h = rules[id](); return h === null ? { id, ok: true, na: true, hint: '' } : { id, ok: h === '', na: false, hint: h }; });
  const live = results.filter(x => !x.na);
  return { results, passed: live.filter(x => x.ok).length, total: live.length };
}

// Which boxes each rule reads (used to tie an AI second opinion to the exact text it judged)
export const RULE_ROLES = { trigger: ['pre'], time: ['pre', 'mem'], past: ['mem'], explain: ['mem'], ret: ['post'], link: ['link'], act: ['act'] };
export const roleTexts = (frame, parts) => Object.fromEntries(frame.map((f, i) => [f.r, String(parts[i] || '').trim()]));
