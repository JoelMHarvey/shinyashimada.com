import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
await import(join(HERE, '../assets/js/srs.js'));
const SRS = globalThis.SRS;
let pass=0; const fails=[];
const check=(n,a,e)=>{ const A=JSON.stringify(a),E=JSON.stringify(e); if(A===E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`); };
const T = '2026-08-27T10:00:00Z';
const day = iso => new Date(iso).toISOString().slice(0,10);

/* --- scheduling ladder ------------------------------------------------- */
let s = SRS.schedule(null, 'good', T);
check('first correct -> 1 day', s.interval, 1);
check('reps incremented', s.reps, 1);
check('due tomorrow', day(s.due), '2026-08-28');

s = SRS.schedule(s, 'good', T);
check('second correct -> 6 days', s.interval, 6);
s = SRS.schedule(s, 'good', T);
check('third correct -> interval * ease', s.interval, Math.round(6 * s.ease));
check('ease stays at 2.5 for "good"', s.ease, 2.5);

/* Easy raises ease, hard lowers it, and it never falls below the floor. */
let e = SRS.schedule(null,'easy',T);
check('easy raises ease', e.ease > 2.5, true);
let h = SRS.freshState();
for (let i=0;i<12;i++) h = SRS.schedule(h,'hard',T);
check('ease floored at 1.3', h.ease, 1.3);

/* A lapse resets reps but is remembered. */
let ok = SRS.schedule(SRS.schedule(SRS.schedule(null,'good',T),'good',T),'good',T);
let lapsed = SRS.schedule(ok, 'wrong', T);
check('wrong resets reps', lapsed.reps, 0);
check('wrong -> back to 1 day', lapsed.interval, 1);
check('lapse counted', lapsed.lapses, 1);
check('wrong drops ease', lapsed.ease < ok.ease, true);

/* --- due logic --------------------------------------------------------- */
check('unseen item is due', SRS.isDue(null, T), true);
check('scheduled ahead is not due', SRS.isDue({due:'2026-09-01T00:00:00Z'}, T), false);
check('scheduled in past is due', SRS.isDue({due:'2026-08-20T00:00:00Z'}, T), true);
check('due today is due', SRS.isDue({due:'2026-08-27T00:00:00Z'}, T), true);
check('learned needs a week', [SRS.isLearned({interval:6}), SRS.isLearned({interval:7})], [false,true]);

/* --- session building -------------------------------------------------- */
const items = Array.from({length:20},(_,i)=>({id:'i'+i}));
const states = {};
states.i0 = {due:'2026-08-01T00:00:00Z', interval:3};   // very overdue
states.i1 = {due:'2026-08-25T00:00:00Z', interval:3};   // overdue
states.i2 = {due:'2026-12-01T00:00:00Z', interval:40};  // far future
const sess = SRS.buildSession(items, states, 5, T);
check('session size', sess.length, 5);
check('most overdue first', sess[0].id, 'i0');
check('then next overdue', sess[1].id, 'i1');
check('then unseen items', sess.slice(2).map(x=>x.id), ['i3','i4','i5']);
check('far-future item not padded in', sess.some(x=>x.id==='i2'), false);
/* When everything is scheduled ahead, fall back to the soonest-due. */
const allFuture = {}; items.forEach((it,i)=>allFuture[it.id]={due:`2026-09-${String(i+1).padStart(2,'0')}T00:00:00Z`,interval:9});
const s2 = SRS.buildSession(items, allFuture, 3, T);
check('falls back to soonest due', s2.map(x=>x.id), ['i0','i1','i2']);

/* --- answer checking --------------------------------------------------- */
check('exact', SRS.check('acqua','acqua'), 'correct');
check('case-insensitive', SRS.check('CIAO','ciao'), 'correct');
check('accents optional', SRS.check('caffe','caffè'), 'correct');
check('accents supplied', SRS.check('caffè','caffe'), 'correct');
check('leading article dropped from answer', SRS.check("l'acqua","acqua"), 'correct');
check('leading article dropped from target', SRS.check('pane','il pane'), 'correct');
check('article kept on both sides', SRS.check('il pane','il pane'), 'correct');
check('punctuation ignored', SRS.check('come stai?','come stai'), 'correct');
check('either side of a slash', SRS.check('bye','hi / bye'), 'correct');
check('other side of a slash', SRS.check('hi','hi / bye'), 'correct');
check('single-letter slip is a typo', SRS.check('aqua','acqua'), 'typo');
check('short-word slip is a typo', SRS.check('can','cane'), 'typo');
check('a different word is wrong', SRS.check('vino','acqua'), 'wrong');
check('empty is wrong', SRS.check('   ','acqua'), 'wrong');
check('whitespace collapsed', SRS.check('  sempre   dritto ','sempre dritto'), 'correct');

console.log(fails.length ? `${pass} passed, ${fails.length} FAILED:\n`+fails.map(f=>'  ✗ '+f).join('\n')
                         : `✓ all ${pass} SRS assertions passed`);
process.exit(fails.length?1:0);
