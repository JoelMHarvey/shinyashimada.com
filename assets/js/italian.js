/* ==========================================================================
   italian.js — the Italian game.

   Playable from English, Japanese or Spanish, because those are the three
   languages Shin reads and each makes Italian a different kind of puzzle
   (Spanish is nearly free; Japanese is not).

   Scheduling and answer checking live in srs.js, which is unit-tested. This
   file is the game around them: session assembly, four question modes,
   scoring and the progress that persists between visits.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  var SESSION_SIZE = 12;
  var STORE_KEY = 'ss.italian';

  var deck = [];
  var topics = [];
  var byId = Object.create(null);

  var progress = Shell.local.get(STORE_KEY, null) || {
    states: {}, xp: 0, streakDays: 0, lastPlayed: null, sessions: 0
  };

  var sourceLang = Shell.local.get('ss.italian.from', null) || I18N.lang;
  var selectedTopics = Shell.local.get('ss.italian.topics', null) || [];

  var session = null;
  var voice = null;

  I18N.extend({
    'it.title':   { en: 'Italian Game — Shinya Shimada', ja: 'イタリア語ゲーム — 島田 慎也', es: 'Juego de Italiano — Shinya Shimada' },
    'it.eyebrow': { en: 'A1 Italian', ja: 'イタリア語 A1', es: 'Italiano A1' },
    'it.heading': { en: 'Italian Game', ja: 'イタリア語ゲーム', es: 'Juego de Italiano' },
    'it.lede': {
      en: 'Short rounds, four ways of asking, and a scheduler that quietly brings back whatever you keep forgetting.',
      ja: '短いラウンドと4つの出題形式。忘れやすい単語ほど繰り返し出てきます。',
      es: 'Rondas cortas, cuatro formas de preguntar y un programador que devuelve lo que se te olvida.'
    },

    'it.from.title': { en: 'Play from', ja: '出題の言語', es: 'Jugar desde' },
    'it.from.hint': {
      en: 'Italian from Spanish is nearly free; from Japanese it is a proper workout.',
      ja: 'スペイン語からだとほぼそのまま。日本語からだとしっかり練習になります。',
      es: 'Del español al italiano es casi gratis; del japonés es un ejercicio de verdad.'
    },

    'it.topics.title': { en: 'Topics', ja: 'トピック', es: 'Temas' },
    'it.topics.all':   { en: 'Everything', ja: 'すべて', es: 'Todo' },

    'it.stat.xp':      { en: 'XP', ja: 'XP', es: 'XP' },
    'it.stat.streak':  { en: 'Day streak', ja: '連続日数', es: 'Racha' },
    'it.stat.learned': { en: 'Learned', ja: '習得', es: 'Aprendidas' },
    'it.stat.due':     { en: 'Due now', ja: '復習待ち', es: 'Para repasar' },

    'it.start':      { en: 'Start a round', ja: 'ラウンド開始', es: 'Empezar ronda' },
    'it.startDue':   { en: 'Review {n} due', ja: '{n}件を復習', es: 'Repasar {n}' },
    'it.startNote':  { en: '{n} phrases in this selection', ja: 'この選択に{n}件', es: '{n} frases en esta selección' },
    'it.noTopics':   { en: 'Pick at least one topic.', ja: 'トピックを1つ以上選んでください。', es: 'Elige al menos un tema.' },
    'it.quit':       { en: 'End the round', ja: 'ラウンドを終了', es: 'Terminar la ronda' },

    'it.mode.choose':  { en: 'What does this mean?', ja: 'この意味は？', es: '¿Qué significa esto?' },
    'it.mode.reverse': { en: 'Say it in Italian', ja: 'イタリア語では？', es: 'Dilo en italiano' },
    'it.mode.produce': { en: 'Type it in Italian', ja: 'イタリア語で入力', es: 'Escríbelo en italiano' },
    'it.mode.listen':  { en: 'Listen', ja: '聞き取り', es: 'Escucha' },
    'it.listen.hint':  { en: 'Tap to hear it again', ja: 'タップでもう一度', es: 'Toca para oírlo otra vez' },

    'it.check':    { en: 'Check', ja: '答え合わせ', es: 'Comprobar' },
    'it.next':     { en: 'Next', ja: '次へ', es: 'Siguiente' },
    'it.finish':   { en: 'Finish', ja: '終了', es: 'Terminar' },
    'it.skip':     { en: 'I don’t know', ja: '分からない', es: 'No lo sé' },
    'it.typePh':   { en: 'in Italian…', ja: 'イタリア語で…', es: 'en italiano…' },

    'it.fb.correct': { en: 'Correct', ja: '正解', es: 'Correcto' },
    'it.fb.typo':    { en: 'Nearly — watch the spelling', ja: '惜しい — つづりに注意', es: 'Casi — cuidado con la ortografía' },
    'it.fb.wrong':   { en: 'The answer is', ja: '正解は', es: 'La respuesta es' },

    'it.done.kicker': { en: 'Round complete', ja: 'ラウンド終了', es: 'Ronda completada' },
    'it.done.line':   { en: '{c} of {n} correct', ja: '{n}問中{c}問正解', es: '{c} de {n} correctas' },
    'it.done.xp':     { en: '+{n} XP', ja: '+{n} XP', es: '+{n} XP' },
    'it.done.again':  { en: 'Another round', ja: 'もう一回', es: 'Otra ronda' },
    'it.done.back':   { en: 'Done for now', ja: '終わる', es: 'Ya está' },
    'it.done.streak': { en: '{n}-day streak', ja: '{n}日連続', es: 'Racha de {n} días' }
  });

  /* --------------------------------------------------------------- data -- */

  function glossOf(item) { return item[sourceLang] || item.en; }

  function pool() {
    if (!selectedTopics.length) return deck;
    return deck.filter(function (i) { return selectedTopics.indexOf(i.topic) !== -1; });
  }

  function dueCount(list) {
    return list.filter(function (i) { return SRS.isDue(progress.states[i.id]); }).length;
  }

  function save() {
    Shell.local.set(STORE_KEY, progress);
    Shell.local.set('ss.italian.from', sourceLang);
    Shell.local.set('ss.italian.topics', selectedTopics);
  }

  /* --------------------------------------------------------------- voice -- */

  function pickVoice() {
    if (!window.speechSynthesis) return null;
    var voices = speechSynthesis.getVoices() || [];
    for (var i = 0; i < voices.length; i++) {
      if ((voices[i].lang || '').toLowerCase().indexOf('it') === 0) return voices[i];
    }
    return null;
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'it-IT';
      if (voice) u.voice = voice;
      u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch (e) { /* audio is a bonus, never a requirement */ }
  }

  /* ---------------------------------------------------------- lobby view -- */

  function renderStats() {
    var list = pool();
    var learned = deck.filter(function (i) { return SRS.isLearned(progress.states[i.id]); }).length;
    var cells = [
      [I18N.t('it.stat.xp'), String(progress.xp)],
      [I18N.t('it.stat.streak'), String(progress.streakDays || 0)],
      [I18N.t('it.stat.learned'), learned + ' / ' + deck.length],
      [I18N.t('it.stat.due'), String(dueCount(list))]
    ];
    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="stat"><p class="stat__label">' + esc(c[0]) + '</p>' +
        '<p class="stat__value">' + esc(c[1]) + '</p></div>';
    }).join('');
  }

  function renderSourcePicker() {
    var host = $('source-lang');
    host.innerHTML = '';
    [['en', 'English'], ['ja', '日本語'], ['es', 'Español']].forEach(function (l) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = l[1];
      btn.setAttribute('aria-pressed', String(sourceLang === l[0]));
      btn.addEventListener('click', function () {
        sourceLang = l[0];
        save();
        renderLobby();
      });
      host.appendChild(btn);
    });
  }

  function renderTopics() {
    var host = $('topics');
    host.innerHTML = '';
    topics.forEach(function (t) {
      var items = deck.filter(function (i) { return i.topic === t.id; });
      var learned = items.filter(function (i) { return SRS.isLearned(progress.states[i.id]); }).length;
      var on = selectedTopics.indexOf(t.id) !== -1 || !selectedTopics.length;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'topic-chip';
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML =
        '<span class="topic-chip__name">' + esc(I18N.pick(t.name)) + '</span>' +
        '<span class="topic-chip__meta">' + learned + ' / ' + items.length + '</span>';
      btn.addEventListener('click', function () {
        var i = selectedTopics.indexOf(t.id);
        if (!selectedTopics.length) {
          // "All" was implicit — clicking one topic narrows to just it.
          selectedTopics = [t.id];
        } else if (i !== -1) {
          selectedTopics.splice(i, 1);
        } else {
          selectedTopics.push(t.id);
        }
        save();
        renderLobby();
      });
      host.appendChild(btn);
    });
  }

  function renderLobby() {
    renderStats();
    renderSourcePicker();
    renderTopics();

    var list = pool();
    var due = dueCount(list);
    // "Review N due" only makes sense once there is history; on a first visit
    // everything is technically due and the phrasing is just confusing.
    var returning = (progress.sessions || 0) > 0 && due > 0;
    $('start').textContent = returning
      ? I18N.t('it.startDue', { n: Math.min(due, SESSION_SIZE) })
      : I18N.t('it.start');
    $('start').disabled = list.length === 0;
    $('start-note').textContent = list.length
      ? I18N.t('it.startNote', { n: list.length })
      : I18N.t('it.noTopics');
  }

  /* ------------------------------------------------------------ questions -- */

  /** Wrong answers come from the same topic where possible — harder, fairer. */
  function distractors(item, field, count) {
    var same = deck.filter(function (d) {
      return d.id !== item.id && d.topic === item.topic;
    });
    var others = deck.filter(function (d) {
      return d.id !== item.id && d.topic !== item.topic;
    });
    var picked = [];
    var seen = Object.create(null);
    seen[field === 'it' ? item.it : glossOf(item)] = true;

    function take(source) {
      var copy = source.slice();
      while (copy.length && picked.length < count) {
        var d = copy.splice(Math.floor(Math.random() * copy.length), 1)[0];
        var text = field === 'it' ? d.it : glossOf(d);
        if (seen[text]) continue;
        seen[text] = true;
        picked.push(text);
      }
    }
    take(same);
    take(others);
    return picked;
  }

  function modeFor(item) {
    var st = progress.states[item.id];
    var reps = st ? st.reps || 0 : 0;
    // A brand-new phrase is always shown before it is ever demanded back.
    if (!st || reps === 0) return 'choose';

    var modes = ['choose', 'reverse', 'produce'];
    if (voice) modes.push('listen');
    // Recall modes get more weight once an item is established.
    if (reps >= 2) modes.push('produce');
    return modes[Math.floor(Math.random() * modes.length)];
  }

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function startSession() {
    var list = pool();
    if (!list.length) return;

    var items = SRS.buildSession(list, progress.states, SESSION_SIZE);
    session = {
      queue: items.map(function (i) { return { item: i, mode: modeFor(i) }; }),
      index: 0,
      results: [],
      xp: 0
    };

    $('lobby').classList.add('hidden');
    $('done').classList.add('hidden');
    $('play').classList.remove('hidden');
    renderQuestion();
  }

  function renderProgress() {
    var pct = (session.index / session.queue.length) * 100;
    $('progress-fill').style.width = pct + '%';
    $('progress-text').textContent = (session.index + 1) + ' / ' + session.queue.length;
  }

  function renderQuestion() {
    var step = session.queue[session.index];
    var item = step.item;
    renderProgress();
    $('feedback-area').innerHTML = '';

    var q = $('question');
    var answers = $('answer-area');
    answers.innerHTML = '';

    if (step.mode === 'produce' || step.mode === 'reverse') {
      q.innerHTML =
        '<p class="q-kicker">' + esc(I18N.t('it.mode.' + step.mode)) + '</p>' +
        '<p class="q-prompt q-prompt--small">' + esc(glossOf(item)) + '</p>';
    } else if (step.mode === 'listen') {
      q.innerHTML =
        '<p class="q-kicker">' + esc(I18N.t('it.mode.listen')) + '</p>' +
        '<button type="button" class="speak-btn" id="replay">🔊</button>' +
        '<p class="q-sub">' + esc(I18N.t('it.listen.hint')) + '</p>';
      $('replay').addEventListener('click', function () { speak(item.it); });
      speak(item.it);
    } else {
      q.innerHTML =
        '<p class="q-kicker">' + esc(I18N.t('it.mode.choose')) + '</p>' +
        '<p class="q-prompt">' + esc(item.it) + '</p>';
      if (voice) speak(item.it);
    }

    if (step.mode === 'produce') renderTypeInput(step);
    else renderOptions(step);
  }

  function renderOptions(step) {
    var item = step.item;
    // 'reverse' asks for the Italian; the others ask for the meaning.
    var field = step.mode === 'reverse' ? 'it' : 'gloss';
    var correct = field === 'it' ? item.it : glossOf(item);
    var choices = shuffle([correct].concat(distractors(item, field, 3)));

    var host = document.createElement('div');
    host.className = 'options';
    choices.forEach(function (text) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.textContent = text;
      btn.addEventListener('click', function () {
        host.querySelectorAll('.option').forEach(function (o) {
          o.disabled = true;
          if (o.textContent === correct) o.setAttribute('data-state', 'correct');
        });
        if (text !== correct) btn.setAttribute('data-state', 'wrong');
        grade(step, text === correct ? 'correct' : 'wrong', correct);
      });
      host.appendChild(btn);
    });
    $('answer-area').appendChild(host);
  }

  function renderTypeInput(step) {
    var wrap = document.createElement('div');
    wrap.className = 'type-row';
    wrap.innerHTML =
      '<input type="text" id="type-input" autocomplete="off" autocapitalize="off" ' +
      'autocorrect="off" spellcheck="false" placeholder="' + esc(I18N.t('it.typePh')) + '">' +
      '<button type="button" class="btn" id="type-check">' + esc(I18N.t('it.check')) + '</button>';
    $('answer-area').appendChild(wrap);

    var input = $('type-input');
    input.focus();

    function submit() {
      var verdict = SRS.check(input.value, step.item.it);
      input.disabled = true;
      $('type-check').disabled = true;
      input.setAttribute('data-state', verdict === 'wrong' ? 'wrong' : 'correct');
      grade(step, verdict, step.item.it);
    }

    $('type-check').addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  /* -------------------------------------------------------------- grading -- */

  /* A wrong answer still earns a little: attempting is the behaviour worth
     reinforcing, and a round where nothing went right should not read as a
     round that never happened. Mode bonuses are for getting it right. */
  var XP = { correct: 10, typo: 6, wrong: 2 };
  var MODE_BONUS = { choose: 0, reverse: 2, listen: 3, produce: 5 };

  function grade(step, verdict, correctAnswer) {
    var gradeKey = verdict === 'correct' ? 'good' : verdict === 'typo' ? 'hard' : 'wrong';
    progress.states[step.item.id] = SRS.schedule(progress.states[step.item.id], gradeKey);

    var gained = XP[verdict] + (verdict === 'wrong' ? 0 : MODE_BONUS[step.mode]);
    session.xp += gained;
    progress.xp += gained;
    session.results.push({ item: step.item, verdict: verdict, mode: step.mode });
    save();

    var fb = document.createElement('div');
    fb.className = 'feedback';
    fb.setAttribute('data-tone', verdict);
    var last = session.index === session.queue.length - 1;
    fb.innerHTML =
      '<span>' +
        (verdict === 'correct' ? '✓ ' + esc(I18N.t('it.fb.correct'))
        : verdict === 'typo' ? '≈ ' + esc(I18N.t('it.fb.typo')) + ' — <b>' + esc(correctAnswer) + '</b>'
        : '✗ ' + esc(I18N.t('it.fb.wrong')) + ' <b>' + esc(correctAnswer) + '</b>') +
      '</span><span class="fb-spacer"></span>' +
      '<button type="button" class="btn btn--sm" id="next-btn">' +
      esc(I18N.t(last ? 'it.finish' : 'it.next')) + '</button>';
    $('feedback-area').appendChild(fb);

    var next = $('next-btn');
    next.focus();
    next.addEventListener('click', advance);
    document.addEventListener('keydown', enterAdvance);
  }

  function enterAdvance(e) {
    if (e.key === 'Enter' && $('next-btn')) { e.preventDefault(); advance(); }
  }

  function advance() {
    document.removeEventListener('keydown', enterAdvance);
    session.index++;
    if (session.index >= session.queue.length) finish();
    else renderQuestion();
  }

  /* ------------------------------------------------------------- finishing -- */

  function bumpStreak() {
    var today = Shell.isoDate(new Date());
    if (progress.lastPlayed === today) return;
    var yesterday = Shell.isoDate(Shell.addDays(new Date(), -1));
    progress.streakDays = progress.lastPlayed === yesterday ? (progress.streakDays || 0) + 1 : 1;
    progress.lastPlayed = today;
  }

  function finish() {
    bumpStreak();
    progress.sessions = (progress.sessions || 0) + 1;
    save();

    $('play').classList.add('hidden');
    $('done').classList.remove('hidden');
    finishSummary();
  }

  function finishSummary() {
    var correct = session.results.filter(function (r) { return r.verdict !== 'wrong'; }).length;
    var total = session.results.length;

    $('summary-score').textContent = total ? Math.round((correct / total) * 100) + '%' : '—';
    $('summary-line').textContent = I18N.t('it.done.line', { c: correct, n: total }) +
      ' · ' + I18N.t('it.done.streak', { n: progress.streakDays });
    $('summary-xp').textContent = I18N.t('it.done.xp', { n: session.xp });

    $('summary-list').innerHTML = session.results.map(function (r) {
      var mark = r.verdict === 'correct' ? '✓' : r.verdict === 'typo' ? '≈' : '✗';
      var colour = r.verdict === 'correct' ? 'var(--green)' : r.verdict === 'typo' ? 'var(--gold)' : 'var(--danger)';
      return '<li><span class="s-it">' + esc(r.item.it) + '</span>' +
        '<span class="muted">' + esc(glossOf(r.item)) + '</span>' +
        '<span class="s-mark" style="color:' + colour + '">' + mark + '</span></li>';
    }).join('');
  }

  function toLobby() {
    session = null;
    $('play').classList.add('hidden');
    $('done').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    renderLobby();
  }

  /* ------------------------------------------------------------------ boot -- */

  $('start').addEventListener('click', startSession);
  $('again').addEventListener('click', startSession);
  $('back-lobby').addEventListener('click', toLobby);
  $('quit').addEventListener('click', function () {
    if (session && session.results.length) finish();
    else toLobby();
  });
  $('topics-all').addEventListener('click', function () {
    selectedTopics = [];
    save();
    renderLobby();
  });

  document.addEventListener('langchange', function () {
    if (!$('lobby').classList.contains('hidden')) { renderLobby(); return; }

    // Mid-round: repaint the question chrome so the card is never half in one
    // language. Only while the question is still open — re-rendering an
    // already-graded question would hand back a second attempt.
    if (session && !$('play').classList.contains('hidden') && !$('next-btn')) {
      renderQuestion();
      return;
    }

    if (session && !$('done').classList.contains('hidden')) finishSummary();
  });

  Shell.init('italian');

  if (window.speechSynthesis) {
    voice = pickVoice();
    speechSynthesis.onvoiceschanged = function () { voice = pickVoice(); };
  }

  fetch('/data/italian.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      deck = data.items || [];
      topics = data.topics || [];
      deck.forEach(function (i) { byId[i.id] = i; });
      renderLobby();
    })
    .catch(function () {
      Shell.toast(I18N.t('common.error'), 'error');
    });

})();
