/* ==========================================================================
   library.js — the shared book library.

   One collection ('books') in the same synced store the balcony uses, so the
   shelf is the same shelf whether it is opened here or on joelmharvey.com.

   "Enrich" happens in two places: when a book is added (look it up, pick the
   right edition, the form fills itself) and afterwards (fill in what is still
   blank without touching anything already written down). Both go through
   /api/books, which asks Open Library and Google Books and folds the two
   answers together.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  /* ====================================================================== */
  /*  Strings                                                               */
  /* ====================================================================== */

  I18N.extend({
    'lib.title':    { en: 'The Library — Shinya Shimada', ja: '書庫 — 島田 慎也', es: 'La Biblioteca — Shinya Shimada' },
    'lib.eyebrow':  { en: 'Shared shelves', ja: '二人の本棚', es: 'Estantes compartidos' },
    'lib.heading':  { en: 'The Library', ja: '書庫', es: 'La Biblioteca' },
    'lib.lede': {
      en: 'Every book the two of us own, in one place. Scan or type an ISBN and the shelf fills itself in.',
      ja: '二人の蔵書をひとつに。ISBN を入力すれば、書誌情報は自動で埋まります。',
      es: 'Todos los libros que tenemos los dos, en un solo sitio. Escribe un ISBN y la ficha se rellena sola.'
    },

    'lib.lock.title': { en: 'Private shelves', ja: 'プライベートな本棚', es: 'Estantes privados' },
    'lib.lock.body': {
      en: 'The library syncs between our devices, so it asks for the shared passcode.',
      ja: '書庫は端末間で同期されるため、共有パスコードが必要です。',
      es: 'La biblioteca se sincroniza entre nuestros dispositivos, así que pide el código compartido.'
    },
    'lib.lock.passcode': { en: 'Passcode', ja: 'パスコード', es: 'Código' },
    'lib.lock.unlock':   { en: 'Unlock', ja: 'ロック解除', es: 'Desbloquear' },
    'lib.lock.offline':  { en: 'Use this device only, without syncing', ja: 'この端末だけで使う（同期しない）', es: 'Usar solo en este dispositivo, sin sincronizar' },
    'lib.lock.wrong':    { en: 'That passcode was not accepted.', ja: 'パスコードが正しくありません。', es: 'Ese código no se aceptó.' },

    /* --- shelf summary --- */
    'lib.stat.books':   { en: 'Books', ja: '冊', es: 'Libros' },
    'lib.stat.read':    { en: 'Read', ja: '読了', es: 'Leídos' },
    'lib.stat.reading': { en: 'Reading', ja: '読書中', es: 'Leyendo' },
    'lib.stat.unread':  { en: 'To read', ja: '未読', es: 'Por leer' },
    'lib.stat.lent':    { en: 'Lent out', ja: '貸出中', es: 'Prestados' },
    'lib.stat.authors': { en: 'Authors', ja: '著者', es: 'Autores' },
    'lib.stat.pages':   { en: 'Pages read', ja: '読んだページ', es: 'Páginas leídas' },

    /* --- toolbar --- */
    'lib.search':      { en: 'Search title, author, subject…', ja: 'タイトル・著者・主題で検索…', es: 'Buscar título, autor, materia…' },
    'lib.add':         { en: 'Add a book', ja: '本を追加', es: 'Añadir un libro' },
    'lib.export':      { en: 'Export as JSON', ja: 'JSON で書き出し', es: 'Exportar como JSON' },
    'lib.filter.owner':  { en: 'Whose', ja: '所有者', es: 'De quién' },
    'lib.filter.status': { en: 'Status', ja: '状態', es: 'Estado' },
    'lib.sort':          { en: 'Sort', ja: '並び替え', es: 'Ordenar' },
    'lib.sort.added':   { en: 'Recently added', ja: '追加順', es: 'Añadidos recientemente' },
    'lib.sort.title':   { en: 'Title', ja: 'タイトル', es: 'Título' },
    'lib.sort.author':  { en: 'Author', ja: '著者', es: 'Autor' },
    'lib.sort.year':    { en: 'Year', ja: '出版年', es: 'Año' },
    'lib.sort.rating':  { en: 'Rating', ja: '評価', es: 'Valoración' },

    /* --- owners --- */
    'lib.owner.joel': { en: "Joel's", ja: 'ジョエル', es: 'De Joel' },
    'lib.owner.shin': { en: "Shin's", ja: 'シンヤ',   es: 'De Shin' },
    'lib.owner.both': { en: 'Ours',   ja: '二人の',   es: 'Nuestro' },

    /* --- statuses --- */
    'lib.status.unread':  { en: 'To read', ja: '未読',   es: 'Por leer' },
    'lib.status.reading': { en: 'Reading', ja: '読書中', es: 'Leyendo' },
    'lib.status.read':    { en: 'Read',    ja: '読了',   es: 'Leído' },
    'lib.status.lent':    { en: 'Lent out', ja: '貸出中', es: 'Prestado' },

    /* --- empty states --- */
    'lib.empty.title': { en: 'No books yet', ja: 'まだ本がありません', es: 'Aún no hay libros' },
    'lib.empty.body': {
      en: 'Add the first one — an ISBN is enough, the rest is looked up for you.',
      ja: '最初の一冊を追加しましょう。ISBN があれば、残りは自動で調べます。',
      es: 'Añade el primero — basta un ISBN, el resto se busca solo.'
    },
    'lib.empty.filtered':      { en: 'Nothing matches', ja: '該当する本がありません', es: 'Nada coincide' },
    'lib.empty.filteredBody':  { en: 'Try a different search or clear the filters.', ja: '検索語を変えるか、フィルターを解除してください。', es: 'Prueba otra búsqueda o quita los filtros.' },
    'lib.clearFilters':        { en: 'Clear filters', ja: 'フィルターを解除', es: 'Quitar filtros' },

    /* --- detail --- */
    'lib.d.by':          { en: 'by {authors}', ja: '{authors}', es: 'por {authors}' },
    'lib.d.publisher':   { en: 'Publisher', ja: '出版社', es: 'Editorial' },
    'lib.d.published':   { en: 'Published', ja: '出版年', es: 'Publicado' },
    'lib.d.pages':       { en: 'Pages', ja: 'ページ数', es: 'Páginas' },
    'lib.d.isbn':        { en: 'ISBN', ja: 'ISBN', es: 'ISBN' },
    'lib.d.language':    { en: 'Language', ja: '言語', es: 'Idioma' },
    'lib.d.shelf':       { en: 'Shelf', ja: '置き場所', es: 'Estante' },
    'lib.d.subjects':    { en: 'Subjects', ja: '主題', es: 'Materias' },
    'lib.d.lentTo':      { en: 'Lent to', ja: '貸出先', es: 'Prestado a' },
    'lib.d.added':       { en: 'Added', ja: '追加日', es: 'Añadido' },
    'lib.d.enrich':      { en: 'Fill in the gaps', ja: '不足情報を補う', es: 'Completar lo que falta' },
    'lib.d.enriching':   { en: 'Looking it up…', ja: '照会中…', es: 'Buscando…' },
    'lib.d.enriched':    { en: 'Added {fields} from the catalogues.', ja: 'カタログから {fields} を追加しました。', es: 'Se añadió {fields} desde los catálogos.' },
    'lib.d.enrichNone':  { en: 'Nothing new to add — this record is already complete.', ja: '追加できる情報はありませんでした。', es: 'Nada nuevo que añadir — la ficha ya está completa.' },
    'lib.d.enrichFail':  { en: 'The catalogues had nothing for this one.', ja: 'カタログに該当がありませんでした。', es: 'Los catálogos no tenían nada para este.' },

    /* --- editor --- */
    'lib.f.new':       { en: 'Add a book', ja: '本を追加', es: 'Añadir un libro' },
    'lib.f.edit':      { en: 'Edit book', ja: '本を編集', es: 'Editar libro' },
    'lib.f.lookup':    { en: 'ISBN, or title and author', ja: 'ISBN、またはタイトルと著者', es: 'ISBN, o título y autor' },
    'lib.f.lookupHint':{ en: 'Look the book up and the fields below fill themselves in.', ja: '検索すると、下の項目が自動で入力されます。', es: 'Busca el libro y los campos de abajo se rellenan solos.' },
    'lib.f.lookupGo':  { en: 'Look up', ja: '検索', es: 'Buscar' },
    'lib.f.looking':   { en: 'Searching…', ja: '検索中…', es: 'Buscando…' },
    'lib.f.noResults': { en: 'No matches — fill the form in by hand.', ja: '該当なし — 手入力してください。', es: 'Sin resultados — rellénalo a mano.' },
    'lib.f.lookupFail':{ en: 'Could not reach the catalogues. The form still works by hand.', ja: 'カタログに接続できません。手入力は可能です。', es: 'No se pudo contactar con los catálogos. El formulario sigue funcionando a mano.' },
    'lib.f.use':       { en: 'Use this', ja: 'これを使う', es: 'Usar este' },
    'lib.f.title':     { en: 'Title', ja: 'タイトル', es: 'Título' },
    'lib.f.subtitle':  { en: 'Subtitle', ja: 'サブタイトル', es: 'Subtítulo' },
    'lib.f.authors':   { en: 'Authors', ja: '著者', es: 'Autores' },
    'lib.f.authorsHint': { en: 'Separate several with commas', ja: '複数はカンマ区切り', es: 'Separa varios con comas' },
    'lib.f.publisher': { en: 'Publisher', ja: '出版社', es: 'Editorial' },
    'lib.f.year':      { en: 'Year', ja: '出版年', es: 'Año' },
    'lib.f.pages':     { en: 'Pages', ja: 'ページ数', es: 'Páginas' },
    'lib.f.isbn':      { en: 'ISBN', ja: 'ISBN', es: 'ISBN' },
    'lib.f.language':  { en: 'Language', ja: '言語', es: 'Idioma' },
    'lib.f.subjects':  { en: 'Subjects', ja: '主題', es: 'Materias' },
    'lib.f.description': { en: 'Description', ja: '内容', es: 'Descripción' },
    'lib.f.owner':     { en: 'Whose is it', ja: '所有者', es: 'De quién es' },
    'lib.f.status':    { en: 'Status', ja: '状態', es: 'Estado' },
    'lib.f.shelf':     { en: 'Shelf or room', ja: '置き場所', es: 'Estante o habitación' },
    'lib.f.lentTo':    { en: 'Lent to', ja: '貸出先', es: 'Prestado a' },
    'lib.f.rating':    { en: 'Rating', ja: '評価', es: 'Valoración' },
    'lib.f.notes':     { en: 'Notes', ja: 'メモ', es: 'Notas' },
    'lib.f.cover':     { en: 'Cover', ja: '表紙', es: 'Portada' },
    'lib.f.coverAdd':  { en: 'Use my own photo', ja: '自分の写真を使う', es: 'Usar mi propia foto' },
    'lib.f.coverChange': { en: 'Change photo', ja: '写真を変更', es: 'Cambiar foto' },
    'lib.f.coverRemove': { en: 'Remove', ja: '削除', es: 'Quitar' },
    'lib.f.needTitle': { en: 'A title is the one thing a book needs.', ja: 'タイトルは必須です。', es: 'El título es lo único imprescindible.' },
    'lib.coverErr':    { en: 'Could not read that image — try a different one.', ja: 'その画像を読み込めませんでした。別の画像をお試しください。', es: 'No se pudo leer esa imagen — prueba con otra.' },
    'lib.confirmDelete': { en: 'Remove this book from the library?', ja: 'この本を書庫から削除しますか？', es: '¿Quitar este libro de la biblioteca?' },

    'lib.rating.none': { en: 'Not rated', ja: '未評価', es: 'Sin valorar' },

    /* --- shelf inventory import --- */
    'lib.import':      { en: 'Import the shelf inventory', ja: '蔵書リストを読み込む', es: 'Importar el inventario' },
    'lib.importing':   { en: 'Importing…', ja: '読み込み中…', es: 'Importando…' },
    'lib.imported':    { en: 'Added {n} books from the shelf inventory.', ja: '蔵書リストから {n} 冊を追加しました。', es: 'Se añadieron {n} libros del inventario.' },
    'lib.importNone':  { en: 'Those books are already on the shelf.', ja: 'それらの本はすでに登録済みです。', es: 'Esos libros ya están en la estantería.' },
    'lib.importFail':  { en: 'Could not read the inventory file.', ja: '蔵書リストを読み込めませんでした。', es: 'No se pudo leer el archivo del inventario.' },

    /* --- checking --- */
    'lib.check.chip':   { en: 'Check', ja: '要確認', es: 'Revisar' },
    'lib.check.filter': { en: 'Needs checking', ja: '要確認のみ', es: 'Por revisar' },
    'lib.check.low':    { en: 'Read off the shelf photo with low confidence — worth confirming.', ja: '棚の写真からの読み取り精度が低い項目です。確認をおすすめします。', es: 'Leído de la foto del estante con poca confianza — conviene confirmarlo.' },
    'lib.check.medium': { en: 'Read off the shelf photo with moderate confidence.', ja: '棚の写真からの読み取り精度は中程度です。', es: 'Leído de la foto del estante con confianza media.' },

    /* --- shelf filter --- */
    'lib.filter.shelf': { en: 'Shelf', ja: '棚', es: 'Estante' },

    /* --- bulk enrichment --- */
    'lib.bulk.start':   { en: 'Fill in the gaps', ja: '不足情報をまとめて補う', es: 'Completar lo que falta' },
    'lib.bulk.stop':    { en: 'Stop', ja: '停止', es: 'Detener' },
    'lib.bulk.none':    { en: 'Every book already has everything the catalogues offer.', ja: 'すべての本にカタログの情報が揃っています。', es: 'Todos los libros ya tienen lo que ofrecen los catálogos.' },
    'lib.bulk.progress':{ en: '{done} of {total} looked up · {filled} filled in', ja: '{total} 冊中 {done} 冊を照会 · {filled} 冊を補完', es: '{done} de {total} consultados · {filled} completados' },
    'lib.bulk.done':    { en: 'Finished: {filled} of {total} books filled in.', ja: '完了：{total} 冊中 {filled} 冊を補完しました。', es: 'Terminado: {filled} de {total} libros completados.' },
    'lib.bulk.stopped': { en: 'Stopped after {done}. {filled} filled in.', ja: '{done} 冊で停止しました。{filled} 冊を補完。', es: 'Detenido tras {done}. {filled} completados.' },
    'lib.bulk.hint': {
      en: 'Asks Open Library and Google Books about every book that is missing a publisher, year, cover or blurb. One at a time, so the catalogues are not hammered — it can take a couple of minutes.',
      ja: '出版社・出版年・表紙・あらすじが欠けている本を Open Library と Google Books に順に照会します。負荷をかけないよう一冊ずつ行うため、数分かかることがあります。',
      es: 'Consulta Open Library y Google Books para cada libro al que le falte editorial, año, portada o sinopsis. De uno en uno, para no saturar los catálogos — puede tardar un par de minutos.'
    }
  });

  /* ====================================================================== */
  /*  Model                                                                 */
  /* ====================================================================== */

  var OWNERS   = ['joel', 'shin', 'both'];
  var STATUSES = ['unread', 'reading', 'read', 'lent'];

  var STATUS_CHIP = {
    unread:  'chip',
    reading: 'chip chip--sky',
    read:    'chip chip--green',
    lent:    'chip chip--gold'
  };

  var store = Store.open('books');

  var filters = { q: '', owner: 'all', status: 'all', shelf: 'all', sort: 'added', check: false };
  var editingId = null;
  var detailId = null;
  var editorCover;          // undefined = untouched · null = removed · string = new
  var lookupResults = [];

  function books() { return store.items(); }

  function authorsOf(b) { return Array.isArray(b.authors) ? b.authors : []; }

  function authorLine(b) { return authorsOf(b).join(', '); }

  /** The image to show: an own photo wins over a catalogue cover. */
  function coverOf(b) { return b.cover || b.coverUrl || null; }

  /** A stable colour per book, so the placeholder spines are not all alike. */
  function spineHue(b) {
    var s = String(b.title || b.id || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  /* Rows catalogued from a photo of the shelves carry how sure the reading
     was. Anything below 'high' is worth a human glance, so it is filterable
     and marked on the card. */
  function needsCheck(b) {
    return b.confidence === 'low' || b.confidence === 'medium';
  }

  function statusOf(b) {
    return STATUSES.indexOf(b.status) === -1 ? 'unread' : b.status;
  }

  function ownerOf(b) {
    return OWNERS.indexOf(b.owner) === -1 ? 'both' : b.owner;
  }

  /* ====================================================================== */
  /*  Filtering and sorting                                                 */
  /* ====================================================================== */

  function matches(b) {
    if (filters.owner !== 'all' && ownerOf(b) !== filters.owner) return false;
    if (filters.status !== 'all' && statusOf(b) !== filters.status) return false;
    if (filters.shelf !== 'all' && (b.location || '') !== filters.shelf) return false;
    if (filters.check && !needsCheck(b)) return false;
    if (!filters.q) return true;
    var hay = [
      b.title, b.subtitle, authorLine(b), b.publisher, b.notes,
      (b.subjects || []).join(' '), b.isbn13, b.isbn10, b.location
    ].join(' ').toLowerCase();
    return filters.q.toLowerCase().split(/\s+/).every(function (term) {
      return hay.indexOf(term) !== -1;
    });
  }

  function sorted(list) {
    var out = list.slice();
    var by = filters.sort;
    out.sort(function (a, b) {
      if (by === 'title')  return String(a.title || '').localeCompare(String(b.title || ''), I18N.locale());
      if (by === 'author') return authorLine(a).localeCompare(authorLine(b), I18N.locale());
      if (by === 'year')   return (b.publishedYear || 0) - (a.publishedYear || 0);
      if (by === 'rating') return (b.rating || 0) - (a.rating || 0);
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    return out;
  }

  /* ====================================================================== */
  /*  Rendering                                                             */
  /* ====================================================================== */

  function stars(rating, interactive) {
    var n = Number(rating) || 0;
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += interactive
        ? '<button type="button" class="star" data-star="' + i + '" aria-label="' + i + '"' +
          (i <= n ? ' data-on="true"' : '') + '>★</button>'
        : '<span class="star" ' + (i <= n ? 'data-on="true"' : '') + ' aria-hidden="true">★</span>';
    }
    return out;
  }

  function renderStats() {
    var all = books();
    var by = function (s) { return all.filter(function (b) { return statusOf(b) === s; }).length; };
    var authors = {};
    all.forEach(function (b) { authorsOf(b).forEach(function (a) { authors[a.toLowerCase()] = 1; }); });
    var pagesRead = all.reduce(function (sum, b) {
      return statusOf(b) === 'read' && Number(b.pages) ? sum + Number(b.pages) : sum;
    }, 0);

    var cells = [
      ['lib.stat.books',   all.length],
      ['lib.stat.read',    by('read')],
      ['lib.stat.reading', by('reading')],
      ['lib.stat.unread',  by('unread')],
      ['lib.stat.lent',    by('lent')],
      ['lib.stat.authors', Object.keys(authors).length],
      ['lib.stat.pages',   pagesRead]
    ];

    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="stat"><div class="stat__value">' + I18N.formatNumber(c[1]) +
             '</div><div class="stat__label">' + esc(I18N.t(c[0])) + '</div></div>';
    }).join('');
  }

  function cardFor(b) {
    var cover = coverOf(b);
    var status = statusOf(b);
    var art = cover
      ? '<img class="book__cover" src="' + esc(cover) + '" alt="" loading="lazy" ' +
        'onerror="this.classList.add(\'is-broken\')">'
      : '<div class="book__cover book__cover--blank" style="--spine-hue:' + spineHue(b) + '">' +
        '<span>' + esc(b.title || '?') + '</span></div>';

    return '<article class="book" role="button" tabindex="0" data-id="' + esc(b.id) + '">' +
      art +
      '<div class="book__body">' +
        '<h3 class="book__title">' + esc(b.title || '—') + '</h3>' +
        (authorLine(b) ? '<p class="book__author">' + esc(authorLine(b)) + '</p>' : '') +
        '<div class="book__meta">' +
          '<span class="' + STATUS_CHIP[status] + '">' + esc(I18N.t('lib.status.' + status)) + '</span>' +
          '<span class="chip chip--terracotta">' + esc(I18N.t('lib.owner.' + ownerOf(b))) + '</span>' +
          (needsCheck(b) ? '<span class="chip chip--danger" title="' +
            esc(I18N.t('lib.check.' + b.confidence)) + '">' + esc(I18N.t('lib.check.chip')) + '</span>' : '') +
          (b.publishedYear ? '<span class="tiny muted">' + esc(b.publishedYear) + '</span>' : '') +
        '</div>' +
        (b.rating ? '<div class="stars stars--sm">' + stars(b.rating, false) + '</div>' : '') +
      '</div>' +
    '</article>';
  }

  function render() {
    renderStats();
    renderShelfFilter();

    var toCheck = books().filter(needsCheck).length;
    $('f-check').hidden = toCheck === 0;
    $('check-count').textContent = toCheck ? ' (' + I18N.formatNumber(toCheck) + ')' : '';

    var shown = sorted(books().filter(matches));
    var grid = $('grid');
    var empty = $('empty');

    if (!shown.length) {
      grid.innerHTML = '';
      var filtered = books().length > 0;
      empty.innerHTML =
        '<div class="empty-state__icon">' + (filtered ? '🔍' : '📚') + '</div>' +
        '<h2>' + esc(I18N.t(filtered ? 'lib.empty.filtered' : 'lib.empty.title')) + '</h2>' +
        '<p class="muted">' + esc(I18N.t(filtered ? 'lib.empty.filteredBody' : 'lib.empty.body')) + '</p>' +
        (filtered
          ? '<button type="button" class="btn btn--ghost btn--sm mt-1" id="clear-filters">' +
            esc(I18N.t('lib.clearFilters')) + '</button>'
          : '<button type="button" class="btn mt-1" id="do-import">' +
            esc(I18N.t('lib.import')) + '</button>');
      empty.classList.remove('hidden');
      var clear = $('clear-filters');
      if (clear) clear.addEventListener('click', function () {
        filters.q = ''; filters.owner = 'all'; filters.status = 'all';
        filters.shelf = 'all'; filters.check = false;
        $('q').value = '';
        syncFilterControls();
        render();
      });
      var imp = $('do-import');
      if (imp) imp.addEventListener('click', function () { importInventory(imp); });
      return;
    }

    empty.classList.add('hidden');
    empty.innerHTML = '';
    grid.innerHTML = shown.map(cardFor).join('');
  }

  function syncFilterControls() {
    $('f-owner').value = filters.owner;
    $('f-status').value = filters.status;
    $('f-sort').value = filters.sort;
    $('f-check').setAttribute('aria-pressed', String(filters.check));
  }

  /* The shelves come from the books themselves, so an inventory with a
     different set of bookcases needs no code change. */
  function renderShelfFilter() {
    var shelves = {};
    books().forEach(function (b) { if (b.location) shelves[b.location] = 1; });
    var names = Object.keys(shelves).sort(function (a, b) {
      return a.localeCompare(b, I18N.locale(), { numeric: true });
    });

    var sel = $('f-shelf');
    sel.innerHTML = '<option value="all">' + esc(I18N.t('common.all')) + '</option>' +
      names.map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
      }).join('');
    // A shelf that no longer exists must not leave the list silently empty.
    if (filters.shelf !== 'all' && names.indexOf(filters.shelf) === -1) filters.shelf = 'all';
    sel.value = filters.shelf;
    sel.parentElement.hidden = names.length < 2;
  }

  function renderSyncPill() {
    var st = store.status();
    var pill = $('sync-pill');
    pill.setAttribute('data-mode', st.mode);
    var label = st.mode === 'cloud' ? I18N.t('lib.sync.cloud')
      : st.mode === 'local' ? I18N.t('lib.sync.local')
      : I18N.t('common.loading');
    // A backlog is the one thing worth saying out loud: it means these books
    // exist only in this browser.
    if (st.pending) label += ' · ' + I18N.t('lib.sync.pending', { n: I18N.formatNumber(st.pending) });
    $('sync-text').textContent = label;
  }

  /* ====================================================================== */
  /*  Detail                                                                */
  /* ====================================================================== */

  function row(labelKey, value) {
    if (value === null || value === undefined || value === '') return '';
    return '<div class="kv"><dt>' + esc(I18N.t(labelKey)) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function openDetail(id) {
    var b = store.get(id);
    if (!b || b.deleted) return;
    detailId = id;
    var cover = coverOf(b);
    var status = statusOf(b);

    $('detail-title').textContent = b.title || '—';
    $('detail-body').innerHTML =
      '<div class="detail-grid">' +
        (cover
          ? '<img class="detail__cover" src="' + esc(cover) + '" alt="">'
          : '<div class="detail__cover book__cover--blank" style="--spine-hue:' + spineHue(b) + '">' +
            '<span>' + esc(b.title || '?') + '</span></div>') +
        '<div>' +
          (b.subtitle ? '<p class="detail__subtitle">' + esc(b.subtitle) + '</p>' : '') +
          (authorLine(b)
            ? '<p class="detail__authors">' + esc(I18N.t('lib.d.by', { authors: authorLine(b) })) + '</p>'
            : '') +
          '<div class="flex items-center gap-1 wrap-flex mb-1">' +
            '<span class="' + STATUS_CHIP[status] + '">' + esc(I18N.t('lib.status.' + status)) + '</span>' +
            '<span class="chip chip--terracotta">' + esc(I18N.t('lib.owner.' + ownerOf(b))) + '</span>' +
          '</div>' +
          '<div class="stars">' + stars(b.rating, false) +
            (b.rating ? '' : ' <span class="tiny muted">' + esc(I18N.t('lib.rating.none')) + '</span>') +
          '</div>' +
          '<dl class="kv-list">' +
            row('lib.d.publisher', b.publisher) +
            row('lib.d.published', b.publishedYear) +
            row('lib.d.pages', b.pages ? I18N.formatNumber(b.pages) : '') +
            row('lib.d.isbn', b.isbn13 || b.isbn10) +
            row('lib.d.language', b.language) +
            row('lib.d.shelf', b.location) +
            row('lib.d.lentTo', status === 'lent' ? b.lentTo : '') +
            row('lib.d.added', b.createdAt ? I18N.formatDate(b.createdAt) : '') +
          '</dl>' +
        '</div>' +
      '</div>' +
      ((b.subjects || []).length
        ? '<div class="flex items-center gap-1 wrap-flex mt-1">' +
          b.subjects.map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('') +
          '</div>'
        : '') +
      (needsCheck(b)
        ? '<p class="notice notice--danger detail__check"><span class="notice__icon">⚠</span>' +
          esc(I18N.t('lib.check.' + b.confidence)) + '</p>'
        : '') +
      (b.description ? '<p class="detail__desc">' + esc(b.description) + '</p>' : '') +
      (b.notes
        ? '<div class="detail__notes"><strong>' + esc(I18N.t('common.notes')) + '</strong>' +
          '<p>' + esc(b.notes) + '</p></div>'
        : '');

    $('detail-edit').onclick = function () { $('detail').close(); openEditor(id); };
    $('detail-enrich').onclick = function () { enrichExisting(id); };
    $('detail').showModal();
  }

  /* ====================================================================== */
  /*  Enrichment                                                            */
  /* ====================================================================== */

  /** GET /api/books, carrying the passcode the store already holds. */
  function lookup(params) {
    var headers = {};
    var code = Store.auth.get();
    if (code) headers['X-Store-Passcode'] = code;
    return fetch('/api/books?' + params, { headers: headers })
      .then(function (res) {
        return res.text().then(function (text) {
          var payload = null;
          try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
          if (!res.ok) throw new Error((payload && payload.error) || ('HTTP ' + res.status));
          return (payload && payload.results) || [];
        });
      });
  }

  /* Fields worth filling from a catalogue. `notes`, `rating`, `owner`,
     `status` and `location` are deliberately absent: those are ours to say,
     and a lookup must never overwrite them. */
  var ENRICHABLE = [
    ['subtitle', 'lib.f.subtitle'], ['authors', 'lib.f.authors'], ['publisher', 'lib.f.publisher'],
    ['publishedYear', 'lib.f.year'], ['pages', 'lib.f.pages'], ['language', 'lib.f.language'],
    ['subjects', 'lib.f.subjects'], ['description', 'lib.f.description'],
    ['coverUrl', 'lib.f.cover'], ['isbn13', 'lib.f.isbn']
  ];

  function isBlank(v) {
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  }

  /** Fill only what is missing, and say which fields were filled. */
  function enrichExisting(id) {
    var b = store.get(id);
    if (!b) return;

    var btn = $('detail-enrich');
    var was = btn.textContent;
    btn.disabled = true;
    btn.textContent = I18N.t('lib.d.enriching');

    var query = b.isbn13 || b.isbn10
      ? 'isbn=' + encodeURIComponent(b.isbn13 || b.isbn10)
      : 'q=' + encodeURIComponent([b.title, authorsOf(b)[0]].filter(Boolean).join(' '));

    lookup(query)
      .then(function (results) {
        var best = results[0];
        if (!best) { Shell.toast(I18N.t('lib.d.enrichFail'), 'error'); return; }

        var filled = [];
        var patch = {};
        ENRICHABLE.forEach(function (pair) {
          var key = pair[0];
          if (!isBlank(b[key]) || isBlank(best[key])) return;
          patch[key] = best[key];
          filled.push(I18N.t(pair[1]));
        });

        if (!filled.length) { Shell.toast(I18N.t('lib.d.enrichNone')); return; }

        store.put(Object.assign({}, b, patch));
        Shell.toast(I18N.t('lib.d.enriched', { fields: filled.join(', ').toLowerCase() }));
        openDetail(id);
      })
      .catch(function () { Shell.toast(I18N.t('lib.f.lookupFail'), 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = was; });
  }

  /* ====================================================================== */
  /*  Importing the shelf inventory                                         */
  /* ====================================================================== */

  /** Loose key for spotting a book we already have. */
  function bookKey(b) {
    return [
      String(b.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      String((b.authors || [])[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    ].join('|');
  }

  /* The inventory was catalogued from photographs of the shelves: titles,
     authors, categories and where each book sits, and nothing else. Anything
     the catalogues can add comes later, from "fill in the gaps". */
  function importInventory(btn) {
    var was = btn.textContent;
    btn.disabled = true;
    btn.textContent = I18N.t('lib.importing');

    fetch('/data/library-seed.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (payload) {
        var have = {};
        books().forEach(function (b) { have[bookKey(b)] = true; });

        var fresh = (payload.books || []).filter(function (b) { return !have[bookKey(b)]; });
        if (!fresh.length) { Shell.toast(I18N.t('lib.importNone')); return; }

        store.putMany(fresh);
        Shell.toast(I18N.t('lib.imported', { n: I18N.formatNumber(fresh.length) }));
      })
      .catch(function () { Shell.toast(I18N.t('lib.importFail'), 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = was; });
  }

  /* ====================================================================== */
  /*  Filling the gaps across the whole shelf                               */
  /* ====================================================================== */

  var bulk = { running: false, stop: false };

  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* Without an ISBN a lookup is only a guess at the title, and the inventory
     holds some misreadings ("Hedro", "Stella Artois"). Accepting whatever
     came back would write confident nonsense into the record, so a title-only
     match has to actually look like the book we asked about. */
  function titlesLookAlike(asked, got) {
    var a = normTitle(asked), b = normTitle(got);
    if (!a || !b) return false;
    return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
  }

  function booksMissingData() {
    return books().filter(function (b) {
      return ENRICHABLE.some(function (pair) { return isBlank(b[pair[0]]); });
    });
  }

  function setBulkProgress(done, total, filled) {
    $('bulk-bar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    $('bulk-text').textContent = I18N.t('lib.bulk.progress', {
      done: I18N.formatNumber(done), total: I18N.formatNumber(total), filled: I18N.formatNumber(filled)
    });
  }

  function runBulkEnrich() {
    if (bulk.running) { bulk.stop = true; return; }

    var queue = booksMissingData();
    if (!queue.length) { Shell.toast(I18N.t('lib.bulk.none')); return; }

    bulk.running = true;
    bulk.stop = false;
    $('bulk').hidden = false;
    $('bulk-go').textContent = I18N.t('lib.bulk.stop');
    setBulkProgress(0, queue.length, 0);

    var i = 0, filled = 0, pending = [];
    var flush = function () {
      if (!pending.length) return;
      store.putMany(pending);
      pending = [];
    };

    var finish = function (stopped) {
      flush();
      bulk.running = false;
      $('bulk').hidden = true;
      $('bulk-go').textContent = I18N.t('lib.bulk.start');
      Shell.toast(I18N.t(stopped ? 'lib.bulk.stopped' : 'lib.bulk.done', {
        done: I18N.formatNumber(i), total: I18N.formatNumber(queue.length),
        filled: I18N.formatNumber(filled)
      }));
    };

    var step = function () {
      if (bulk.stop) return finish(true);
      if (i >= queue.length) return finish(false);

      var b = queue[i++];
      setBulkProgress(i, queue.length, filled);

      var byIsbn = !!(b.isbn13 || b.isbn10);
      var query = byIsbn
        ? 'isbn=' + encodeURIComponent(b.isbn13 || b.isbn10)
        : 'q=' + encodeURIComponent([b.title, authorsOf(b)[0]].filter(Boolean).join(' '));

      lookup(query)
        .then(function (results) {
          var best = results[0];
          if (!best) return;
          if (!byIsbn && !titlesLookAlike(b.title, best.title)) return;

          var current = store.get(b.id);
          if (!current || current.deleted) return;

          var patch = {}, any = false;
          ENRICHABLE.forEach(function (pair) {
            var key = pair[0];
            if (!isBlank(current[key]) || isBlank(best[key])) return;
            patch[key] = best[key];
            any = true;
          });
          if (any) { pending.push(Object.assign({}, current, patch)); filled++; }
        })
        .catch(function () { /* one dead lookup must not end the run */ })
        .then(function () {
          if (pending.length >= 25) flush();
          // Gentle on catalogues that ask for it, and on a phone battery.
          setTimeout(step, 260);
        });
    };

    step();
  }

  /* ====================================================================== */
  /*  Editor                                                                */
  /* ====================================================================== */

  function setField(id, value) {
    $(id).value = value === null || value === undefined ? '' : String(value);
  }

  function openEditor(id) {
    editingId = id;
    editorCover = undefined;
    lookupResults = [];
    $('lookup-results').innerHTML = '';
    $('lookup-input').value = '';

    var b = id ? store.get(id) : null;
    document.querySelector('#editor .modal__head h2').textContent =
      I18N.t(id ? 'lib.f.edit' : 'lib.f.new');

    setField('f-title', b && b.title);
    setField('f-subtitle', b && b.subtitle);
    setField('f-authors', b ? authorsOf(b).join(', ') : '');
    setField('f-publisher', b && b.publisher);
    setField('f-year', b && b.publishedYear);
    setField('f-pages', b && b.pages);
    setField('f-isbn', b && (b.isbn13 || b.isbn10));
    setField('f-language', b && b.language);
    setField('f-subjects', b && (b.subjects || []).join(', '));
    setField('f-description', b && b.description);
    setField('f-shelf-edit', b && b.location);
    setField('f-lentto', b && b.lentTo);
    setField('f-notes', b && b.notes);
    $('f-owner-edit').value = b ? ownerOf(b) : 'both';
    $('f-status-edit').value = b ? statusOf(b) : 'unread';
    $('f-rating').value = String((b && b.rating) || 0);

    renderRatingField();
    renderCoverField();
    syncLentVisibility();
    $('editor-delete').hidden = !id;
    $('editor').showModal();
    $('lookup-input').focus();
  }

  function renderRatingField() {
    var value = Number($('f-rating').value) || 0;
    $('rating-stars').innerHTML = stars(value, true);
    $('rating-stars').querySelectorAll('[data-star]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var n = Number(btn.getAttribute('data-star'));
        // Clicking the current rating clears it, so a mis-tap is undoable.
        $('f-rating').value = String(n === value ? 0 : n);
        renderRatingField();
      });
    });
  }

  function currentEditorCover() {
    if (editorCover !== undefined) return editorCover;
    var b = editingId ? store.get(editingId) : null;
    return (b && b.cover) || null;
  }

  function renderCoverField() {
    var own = currentEditorCover();
    var b = editingId ? store.get(editingId) : null;
    var remote = $('f-coverurl').value || (b && b.coverUrl) || null;
    var shown = own || remote;

    var img = $('f-cover-preview');
    img.hidden = !shown;
    if (shown) img.src = shown;
    $('f-cover-label').textContent = I18N.t(own ? 'lib.f.coverChange' : 'lib.f.coverAdd');
    $('f-cover-remove').hidden = !own;
  }

  function syncLentVisibility() {
    $('lentto-field').hidden = $('f-status-edit').value !== 'lent';
  }

  /* Covers ride inside the record, which lives in a 64 KB JSONB row, so an
     own photo is downscaled and compressed until it fits. A catalogue cover
     is only a URL and costs nothing. */
  var COVER_BUDGET = 50000;

  function compressCover(file, done, fail) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var dims = [520, 400, 300];
      var quals = [0.72, 0.6, 0.5, 0.4];
      for (var d = 0; d < dims.length; d++) {
        var scale = Math.min(1, dims[d] / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        for (var q = 0; q < quals.length; q++) {
          var out = canvas.toDataURL('image/jpeg', quals[q]);
          if (out.length <= COVER_BUDGET) return done(out);
        }
      }
      fail();
    };
    img.onerror = function () { URL.revokeObjectURL(url); fail(); };
    img.src = url;
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function saveEditor() {
    var title = $('f-title').value.trim();
    if (!title) {
      Shell.toast(I18N.t('lib.f.needTitle'), 'error');
      $('f-title').focus();
      return false;
    }

    var existing = editingId ? store.get(editingId) : null;
    var isbn = String($('f-isbn').value || '').toUpperCase().replace(/[^0-9X]/g, '');
    var year = parseInt($('f-year').value, 10);
    var pages = parseInt($('f-pages').value, 10);

    var record = Object.assign({}, existing, {
      id: editingId || undefined,
      title: title,
      subtitle: $('f-subtitle').value.trim(),
      authors: splitList($('f-authors').value),
      publisher: $('f-publisher').value.trim(),
      publishedYear: Number.isFinite(year) ? year : null,
      pages: Number.isFinite(pages) ? pages : null,
      isbn13: isbn.length === 13 ? isbn : (existing && existing.isbn13) || null,
      isbn10: isbn.length === 10 ? isbn : (existing && existing.isbn10) || null,
      language: $('f-language').value.trim(),
      subjects: splitList($('f-subjects').value),
      description: $('f-description').value.trim(),
      owner: $('f-owner-edit').value,
      status: $('f-status-edit').value,
      location: $('f-shelf-edit').value.trim(),
      lentTo: $('f-status-edit').value === 'lent' ? $('f-lentto').value.trim() : '',
      rating: Number($('f-rating').value) || 0,
      notes: $('f-notes').value.trim(),
      coverUrl: $('f-coverurl').value || (existing && existing.coverUrl) || null,
      cover: editorCover !== undefined ? editorCover : ((existing && existing.cover) || null)
    });

    store.put(record);
    return true;
  }

  /* --- looking a book up from inside the editor ------------------------- */

  function runLookup() {
    var q = $('lookup-input').value.trim();
    if (!q) return;

    var box = $('lookup-results');
    box.innerHTML = '<p class="muted small">' + esc(I18N.t('lib.f.looking')) + '</p>';

    lookup('q=' + encodeURIComponent(q))
      .then(function (results) {
        lookupResults = results;
        if (!results.length) {
          box.innerHTML = '<p class="muted small">' + esc(I18N.t('lib.f.noResults')) + '</p>';
          return;
        }
        box.innerHTML = results.map(function (r, i) {
          return '<div class="hit">' +
            (r.coverUrl ? '<img class="hit__cover" src="' + esc(r.coverUrl) + '" alt="" loading="lazy">' : '<div class="hit__cover"></div>') +
            '<div class="hit__body">' +
              '<strong>' + esc(r.title) + '</strong>' +
              (r.authors && r.authors.length ? '<span class="tiny muted">' + esc(r.authors.join(', ')) + '</span>' : '') +
              '<span class="tiny muted">' +
                [r.publisher, r.publishedYear, r.isbn13].filter(Boolean).map(esc).join(' · ') +
              '</span>' +
            '</div>' +
            '<button type="button" class="btn btn--sm" data-use="' + i + '">' + esc(I18N.t('lib.f.use')) + '</button>' +
          '</div>';
        }).join('');
        box.querySelectorAll('[data-use]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            applyCandidate(lookupResults[Number(btn.getAttribute('data-use'))]);
          });
        });
      })
      .catch(function () {
        box.innerHTML = '<p class="muted small">' + esc(I18N.t('lib.f.lookupFail')) + '</p>';
      });
  }

  /** Fill the form from a search hit, leaving anything already typed alone. */
  function applyCandidate(c) {
    if (!c) return;
    var fill = function (id, value) {
      if (value === null || value === undefined || value === '') return;
      if ($(id).value.trim()) return;
      $(id).value = String(value);
    };
    fill('f-title', c.title);
    fill('f-subtitle', c.subtitle);
    fill('f-authors', (c.authors || []).join(', '));
    fill('f-publisher', c.publisher);
    fill('f-year', c.publishedYear);
    fill('f-pages', c.pages);
    fill('f-isbn', c.isbn13 || c.isbn10);
    fill('f-language', c.language);
    fill('f-subjects', (c.subjects || []).join(', '));
    fill('f-description', c.description);
    if (c.coverUrl && !$('f-coverurl').value) $('f-coverurl').value = c.coverUrl;
    renderCoverField();
    $('lookup-results').innerHTML = '';
    $('f-title').focus();
  }

  /* ====================================================================== */
  /*  Boot                                                                  */
  /* ====================================================================== */

  function showApp() {
    $('lock').classList.add('hidden');
    $('app').classList.remove('hidden');
    render();
    renderSyncPill();
    /* sync(), not pull(): anything written while the store was in local-only
       mode is still sitting in the pending queue, and a read alone would
       leave it there for ever. Pushing first is what gets it off the device. */
    store.sync().then(function () { render(); renderSyncPill(); });
  }

  function showLock(message) {
    $('app').classList.add('hidden');
    $('lock').classList.remove('hidden');
    if (message) Shell.toast(message, 'error');
  }

  function wire() {
    document.querySelectorAll('dialog.modal').forEach(function (dlg) {
      dlg.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { dlg.close(); });
      });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    });

    $('grid').addEventListener('click', function (e) {
      var card = e.target.closest('.book');
      if (card) openDetail(card.getAttribute('data-id'));
    });
    $('grid').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest('.book');
      if (!card) return;
      e.preventDefault();
      openDetail(card.getAttribute('data-id'));
    });

    $('q').addEventListener('input', Shell.debounce(function () {
      filters.q = $('q').value.trim();
      render();
    }, 160));

    ['owner', 'status', 'shelf', 'sort'].forEach(function (key) {
      $('f-' + key).addEventListener('change', function () {
        filters[key] = this.value;
        render();
      });
    });

    $('f-check').addEventListener('click', function () {
      filters.check = !filters.check;
      syncFilterControls();
      render();
    });

    $('bulk-go').addEventListener('click', runBulkEnrich);

    $('add-book').addEventListener('click', function () { openEditor(null); });

    $('lookup-go').addEventListener('click', runLookup);
    $('lookup-input').addEventListener('keydown', function (e) {
      // The editor is inside a <form>; Enter here means "search", not "save".
      if (e.key === 'Enter') { e.preventDefault(); runLookup(); }
    });

    $('f-status-edit').addEventListener('change', syncLentVisibility);

    $('f-cover').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      compressCover(file, function (dataUrl) {
        editorCover = dataUrl;
        renderCoverField();
      }, function () {
        Shell.toast(I18N.t('lib.coverErr'), 'error');
      });
    });

    $('f-cover-remove').addEventListener('click', function () {
      editorCover = null;
      $('f-coverurl').value = '';
      renderCoverField();
    });

    $('editor-form').addEventListener('submit', function (e) {
      if (!saveEditor()) e.preventDefault();
    });

    $('editor-delete').addEventListener('click', function () {
      if (!editingId) return;
      if (!confirm(I18N.t('lib.confirmDelete'))) return;
      store.remove(editingId);
      $('editor').close();
    });

    $('export').addEventListener('click', function () {
      var blob = new Blob([store.exportJSON()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'library-' + Shell.isoDate(new Date()) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    store.onChange(function () { render(); renderSyncPill(); });

    document.addEventListener('langchange', function () {
      if (!$('app').classList.contains('hidden')) { render(); renderSyncPill(); }
      /* A modal left open across a language switch would otherwise keep its
         old labels: the detail body is built in JS so it is rebuilt, the
         editor is static markup so it is repainted in place. */
      if ($('detail').open && detailId) openDetail(detailId);
      if ($('editor').open) I18N.apply($('editor'));
    });
  }

  $('lock-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('lock-input').value;
    if (!code) return;
    Store.auth.set(code);
    /* The passcode is the thing that was missing, so send the backlog now. */
    store.sync().then(function () {
      var st = store.status();
      if (st.lastError && st.lastError.status === 401) {
        Store.auth.clear();
        showLock(I18N.t('lib.lock.wrong'));
      } else {
        showApp();
      }
    });
  });

  $('lock-offline').addEventListener('click', function (e) {
    e.preventDefault();
    showApp();
  });

  I18N.extend({
    'lib.sync.cloud': { en: 'Synced', ja: '同期済み', es: 'Sincronizado' },
    'lib.sync.local': { en: 'This device only', ja: 'この端末のみ', es: 'Solo este dispositivo' },
    'lib.sync.pending': {
      en: '{n} not saved to the shared library yet',
      ja: '{n} 件が共有ライブラリに未保存',
      es: '{n} sin guardar todavía en la biblioteca compartida'
    }
  });

  Shell.init('library');
  wire();
  syncFilterControls();

  Store.health().then(function (h) {
    if (!h.ok || !h.database || !h.authRequired) { showApp(); return; }
    if (Store.auth.has()) { showApp(); return; }
    showLock();
  });

})();
