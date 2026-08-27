/* ==========================================================================
   research.js — a blank instance of the Research Hub that runs on
   joelmharvey.com.

   Everything you can navigate is here — library, folders, tags, chats,
   notes, highlights, key ideas, discovery, import — and everything is empty.
   Folders and tags are real and persist on this device, so the shell can be
   organised before there is anything to put in it. No documents, no backend,
   no pretend data: each view states plainly what it will hold.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  var FOLDER_KEY = 'ss.rh.folders';
  var TAG_KEY = 'ss.rh.tags';

  var folders = Shell.local.get(FOLDER_KEY, []) || [];
  var tags = Shell.local.get(TAG_KEY, []) || [];
  var view = 'library';
  var activeFolder = null;
  var activeTag = null;

  var VIEWS = [
    { id: 'library',    icon: '📚' },
    { id: 'chats',      icon: '💬' },
    { id: 'notes',      icon: '📝' },
    { id: 'highlights', icon: '🖍' },
    { id: 'ideas',      icon: '💡' },
    { id: 'discover',   icon: '🔎' },
    { id: 'import',     icon: '📥' }
  ];

  I18N.extend({
    'rh.title':   { en: 'Research Library — Shinya Shimada', ja: 'リサーチ・ライブラリー — 島田 慎也', es: 'Biblioteca de Investigación — Shinya Shimada' },
    'rh.eyebrow': { en: 'Research portal', ja: 'リサーチ・ポータル', es: 'Portal de investigación' },
    'rh.heading': { en: 'Research Library', ja: 'リサーチ・ライブラリー', es: 'Biblioteca de Investigación' },
    'rh.lede': {
      en: 'The same research portal that runs on joelmharvey.com, handed over empty.',
      ja: 'joelmharvey.com と同じリサーチ・ポータルを、空の状態で。',
      es: 'El mismo portal de investigación de joelmharvey.com, entregado vacío.'
    },
    'rh.brand':    { en: 'Research Hub', ja: 'リサーチ・ハブ', es: 'Research Hub' },
    'rh.searchPh': { en: 'Search library…', ja: 'ライブラリーを検索…', es: 'Buscar en la biblioteca…' },
    'rh.folders':  { en: 'Folders', ja: 'フォルダ', es: 'Carpetas' },
    'rh.tags':     { en: 'Tags', ja: 'タグ', es: 'Etiquetas' },
    'rh.newFolder':{ en: 'New folder…', ja: '新しいフォルダ…', es: 'Nueva carpeta…' },
    'rh.newTag':   { en: 'New tag…', ja: '新しいタグ…', es: 'Nueva etiqueta…' },
    'rh.allDocs':  { en: 'All documents', ja: 'すべての文献', es: 'Todos los documentos' },
    'rh.deleteFolder': { en: 'Delete this folder?', ja: 'このフォルダを削除しますか？', es: '¿Eliminar esta carpeta?' },

    'rh.blank.title': {
      en: 'This instance is deliberately empty.',
      ja: 'このインスタンスは意図的に空です。',
      es: 'Esta instancia está vacía a propósito.'
    },
    'rh.blank.body': {
      en: 'Every screen is here and navigable, with nothing in it. Folders and tags you create are kept on this device. Nothing is uploaded, and no sample documents are invented to make it look busy.',
      ja: '画面はすべて揃っていますが、中身は空です。作成したフォルダとタグはこの端末に保存されます。アップロードは行わず、見栄えのためのサンプル文献も置いていません。',
      es: 'Todas las pantallas están y se pueden recorrer, pero vacías. Las carpetas y etiquetas que crees se guardan en este dispositivo. No se sube nada ni se inventan documentos de ejemplo.'
    },

    'rh.v.library':    { en: 'Library',     ja: 'ライブラリー',   es: 'Biblioteca' },
    'rh.v.chats':      { en: 'Chats',       ja: 'チャット',       es: 'Chats' },
    'rh.v.notes':      { en: 'Notes',       ja: 'メモ',           es: 'Notas' },
    'rh.v.highlights': { en: 'Highlights',  ja: 'ハイライト',     es: 'Subrayados' },
    'rh.v.ideas':      { en: 'Key ideas',   ja: '要点',           es: 'Ideas clave' },
    'rh.v.discover':   { en: 'Discover',    ja: '文献を探す',     es: 'Descubrir' },
    'rh.v.import':     { en: 'Import',      ja: 'インポート',     es: 'Importar' },

    'rh.s.library':    { en: 'Papers, PDFs and web pages, with metadata filled in from Crossref and OpenAlex.', ja: '論文・PDF・Webページ。書誌情報は Crossref と OpenAlex から自動取得します。', es: 'Artículos, PDFs y páginas web, con metadatos de Crossref y OpenAlex.' },
    'rh.s.chats':      { en: 'Ask questions scoped to a document, a folder or the whole library — every claim cited.', ja: '文献・フォルダ・ライブラリー全体を対象に質問。回答には必ず出典がつきます。', es: 'Pregunta sobre un documento, una carpeta o toda la biblioteca, con citas.' },
    'rh.s.notes':      { en: 'Markdown notes with live preview, AI actions on a selection, and @ citations.', ja: 'ライブプレビュー付きの Markdown メモ。選択部分へのAI操作と @ 引用。', es: 'Notas en Markdown con vista previa, acciones de IA y citas con @.' },
    'rh.s.highlights': { en: 'Everything marked while reading, gathered per document or across a folder.', ja: '読みながら引いたハイライトを文献ごと・フォルダごとに集約。', es: 'Todo lo subrayado al leer, por documento o por carpeta.' },
    'rh.s.ideas':      { en: 'The recurring arguments across the library, pulled together.', ja: 'ライブラリー全体で繰り返し現れる論点をまとめます。', es: 'Los argumentos recurrentes de la biblioteca, reunidos.' },
    'rh.s.discover':   { en: 'Search PubMed, OpenAlex and Semantic Scholar together, deduped by DOI.', ja: 'PubMed・OpenAlex・Semantic Scholar を横断検索し、DOIで重複を除きます。', es: 'Busca en PubMed, OpenAlex y Semantic Scholar a la vez, sin duplicados.' },
    'rh.s.import':     { en: 'Drop in a PDF or DOCX, paste a URL, or bring a reference list across.', ja: 'PDF・DOCXを追加、URLを貼り付け、参考文献リストの取り込みも。', es: 'Añade un PDF o DOCX, pega una URL o importa una lista de referencias.' },

    'rh.e.library':    { en: 'No documents yet', ja: 'まだ文献がありません', es: 'Aún no hay documentos' },
    'rh.e.chats':      { en: 'No conversations yet', ja: 'まだチャットがありません', es: 'Aún no hay conversaciones' },
    'rh.e.notes':      { en: 'No notes yet', ja: 'まだメモがありません', es: 'Aún no hay notas' },
    'rh.e.highlights': { en: 'Nothing highlighted yet', ja: 'まだハイライトがありません', es: 'Nada subrayado aún' },
    'rh.e.ideas':      { en: 'No key ideas yet', ja: 'まだ要点がありません', es: 'Aún no hay ideas clave' },
    'rh.e.discover':   { en: 'Nothing searched yet', ja: 'まだ検索していません', es: 'Aún no has buscado' },
    'rh.e.import':     { en: 'Nothing imported yet', ja: 'まだ何もインポートしていません', es: 'Aún no has importado nada' },

    'rh.eb.library':    { en: 'Upload a PDF, or paste the address of a paper, and it lands here with its authors, journal and year already filled in.', ja: 'PDFをアップロードするか論文のURLを貼り付けると、著者・掲載誌・年が自動で入った状態でここに並びます。', es: 'Sube un PDF o pega la dirección de un artículo y aparecerá aquí con autores, revista y año.' },
    'rh.eb.chats':      { en: 'Chats need something to read first. Add a document and the conversation can cite it.', ja: 'チャットにはまず読む対象が必要です。文献を追加すると、それを引用して答えられます。', es: 'Los chats necesitan algo que leer. Añade un documento y podrá citarlo.' },
    'rh.eb.notes':      { en: 'A note can stand on its own, or grow out of what you highlighted while reading.', ja: 'メモは単独でも、ハイライトから育てても構いません。', es: 'Una nota puede ir sola o crecer de lo que subrayaste al leer.' },
    'rh.eb.highlights': { en: 'Open a PDF with “Read & highlight” and anything you select is collected here.', ja: 'PDFを「読む・ハイライト」で開き、選択した箇所がここに集まります。', es: 'Abre un PDF en modo lectura y lo que selecciones se recogerá aquí.' },
    'rh.eb.ideas':      { en: 'Once a few papers are in, the themes they share are surfaced here.', ja: '論文がいくつか集まると、共通するテーマがここに現れます。', es: 'Con varios artículos dentro, aquí aparecerán los temas que comparten.' },
    'rh.eb.discover':   { en: 'Search a question and matching papers come back from three databases at once, ready to import.', ja: '問いを入力すると、3つのデータベースから該当論文が返り、そのまま取り込めます。', es: 'Busca una pregunta y volverán artículos de tres bases de datos, listos para importar.' },
    'rh.eb.import':     { en: 'Bring in a BibTeX file, a RIS export or a plain list of DOIs and they are matched to real records.', ja: 'BibTeX・RIS・DOIのリストを読み込むと、実際の書誌情報に照合されます。', es: 'Importa un BibTeX, un RIS o una lista de DOIs y se emparejarán con registros reales.' },

    'rh.t.upload':   { en: 'Upload', ja: 'アップロード', es: 'Subir' },
    'rh.t.pasteUrl': { en: 'Paste a URL', ja: 'URLを貼り付け', es: 'Pegar una URL' },
    'rh.t.newChat':  { en: 'New chat', ja: '新しいチャット', es: 'Nuevo chat' },
    'rh.t.newNote':  { en: 'New note', ja: '新しいメモ', es: 'Nueva nota' },
    'rh.t.search':   { en: 'Search databases', ja: 'データベースを検索', es: 'Buscar en bases de datos' },
    'rh.t.bibtex':   { en: 'Import BibTeX', ja: 'BibTeXを取り込む', es: 'Importar BibTeX' },
    'rh.t.export':   { en: 'Export', ja: 'エクスポート', es: 'Exportar' },
    'rh.t.disabled': { en: 'These controls are inert in the blank instance.', ja: '空のインスタンスではこれらの操作は無効です。', es: 'Estos controles están inactivos en la instancia vacía.' },

    'rh.count.docs': { en: '0 documents', ja: '0 件', es: '0 documentos' },
    'rh.searchNone': { en: 'Nothing to search yet — the library is empty.', ja: '検索対象がありません。ライブラリーは空です。', es: 'Nada que buscar todavía: la biblioteca está vacía.' },
    'rh.hint': {
      en: 'The working version of this portal, with ingestion, cited chat and reference export, lives at joelmharvey.com.',
      ja: 'このポータルの実働版（文献取り込み・出典つきチャット・書誌エクスポート）は joelmharvey.com にあります。',
      es: 'La versión funcional de este portal vive en joelmharvey.com.'
    }
  });

  /* Toolbar buttons per view — present, labelled, and inert by design. */
  var TOOLBARS = {
    library:    ['rh.t.upload', 'rh.t.pasteUrl', 'rh.t.export'],
    chats:      ['rh.t.newChat'],
    notes:      ['rh.t.newNote', 'rh.t.export'],
    highlights: [],
    ideas:      [],
    discover:   ['rh.t.search'],
    import:     ['rh.t.bibtex']
  };

  function save() {
    Shell.local.set(FOLDER_KEY, folders);
    Shell.local.set(TAG_KEY, tags);
  }

  function renderNav() {
    $('rh-nav').innerHTML = VIEWS.map(function (v) {
      return '<li><button type="button" data-view="' + v.id + '" aria-current="' +
        (view === v.id && !activeFolder && !activeTag) + '">' +
        '<span aria-hidden="true">' + v.icon + '</span>' +
        '<span>' + esc(I18N.t('rh.v.' + v.id)) + '</span>' +
        '<span class="count">0</span></button></li>';
    }).join('');

    $('rh-nav').querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view = btn.getAttribute('data-view');
        activeFolder = null;
        activeTag = null;
        render();
      });
    });
  }

  function renderFolders() {
    var host = $('rh-folders');
    host.innerHTML =
      '<li><button type="button" data-folder="" aria-current="' + (view === 'library' && !activeFolder && !activeTag) + '">' +
      '<span>' + esc(I18N.t('rh.allDocs')) + '</span><span class="count">0</span></button></li>' +
      folders.map(function (f) {
        return '<li><button type="button" data-folder="' + esc(f.id) + '" aria-current="' +
          (activeFolder === f.id) + '"><span>' + esc(f.name) + '</span>' +
          '<span class="count">0</span></button>' +
          '<button type="button" class="rh__folder-del" data-del-folder="' + esc(f.id) + '" ' +
          'aria-label="' + esc(I18N.t('common.delete')) + '">×</button></li>';
      }).join('');

    host.querySelectorAll('[data-folder]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view = 'library';
        activeTag = null;
        activeFolder = btn.getAttribute('data-folder') || null;
        render();
      });
    });
    host.querySelectorAll('[data-del-folder]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm(I18N.t('rh.deleteFolder'))) return;
        var id = btn.getAttribute('data-del-folder');
        folders = folders.filter(function (f) { return f.id !== id; });
        if (activeFolder === id) activeFolder = null;
        save();
        render();
      });
    });
  }

  function renderTags() {
    $('rh-tags').innerHTML = tags.map(function (t) {
      return '<li><button type="button" data-tag="' + esc(t.id) + '" aria-current="' +
        (activeTag === t.id) + '"><span>#' + esc(t.name) + '</span>' +
        '<span class="count">0</span></button>' +
        '<button type="button" class="rh__folder-del" data-del-tag="' + esc(t.id) + '" ' +
        'aria-label="' + esc(I18N.t('common.delete')) + '">×</button></li>';
    }).join('');

    $('rh-tags').querySelectorAll('[data-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view = 'library';
        activeFolder = null;
        activeTag = btn.getAttribute('data-tag');
        render();
      });
    });
    $('rh-tags').querySelectorAll('[data-del-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-del-tag');
        tags = tags.filter(function (t) { return t.id !== id; });
        if (activeTag === id) activeTag = null;
        save();
        render();
      });
    });
  }

  function renderMain() {
    var folder = activeFolder && folders.filter(function (f) { return f.id === activeFolder; })[0];
    var tag = activeTag && tags.filter(function (t) { return t.id === activeTag; })[0];

    $('rh-title').textContent = folder ? folder.name : tag ? '#' + tag.name : I18N.t('rh.v.' + view);
    $('rh-sub').textContent = I18N.t('rh.s.' + (folder || tag ? 'library' : view));
    $('rh-count').textContent = I18N.t('rh.count.docs');
    $('rh-hint').textContent = I18N.t('rh.hint');

    var buttons = TOOLBARS[folder || tag ? 'library' : view] || [];
    $('rh-toolbar').innerHTML = buttons.length
      ? '<div class="rh__toolbar">' + buttons.map(function (k) {
          return '<button class="btn btn--ghost btn--sm" disabled>' + esc(I18N.t(k)) + '</button>';
        }).join('') + '<span class="tiny muted">' + esc(I18N.t('rh.t.disabled')) + '</span></div>'
      : '';

    var key = folder || tag ? 'library' : view;
    $('rh-body').innerHTML =
      '<div class="rh__empty"><div class="rh__empty__icon">' +
      (VIEWS.filter(function (v) { return v.id === key; })[0] || { icon: '📄' }).icon +
      '</div><h3>' + esc(I18N.t('rh.e.' + key)) + '</h3>' +
      '<p>' + esc(I18N.t('rh.eb.' + key)) + '</p></div>';
  }

  function render() {
    renderNav();
    renderFolders();
    renderTags();
    renderMain();
  }

  $('rh-newfolder').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('rh-foldername').value.trim();
    if (!name) return;
    folders.push({ id: Shell.uid(), name: name });
    $('rh-foldername').value = '';
    save();
    render();
  });

  $('rh-newtag').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('rh-tagname').value.trim().replace(/^#/, '');
    if (!name) return;
    tags.push({ id: Shell.uid(), name: name });
    $('rh-tagname').value = '';
    save();
    render();
  });

  $('rh-search').addEventListener('input', Shell.debounce(function () {
    if ($('rh-search').value.trim()) Shell.toast(I18N.t('rh.searchNone'));
  }, 700));

  document.addEventListener('langchange', render);

  Shell.init('research');
  render();

})();
