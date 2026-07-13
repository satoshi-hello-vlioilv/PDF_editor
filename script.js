'use strict';

// ============================================================
// APP VERSION / CHANGELOG
// ============================================================
const APP_VERSION = '1.2.0';
const CHANGELOG = [
  { version: '1.2.0', date: '2026-07-12', notes: [
    'アプリ名の横にバージョン番号を表示（クリックで更新履歴を確認可能）',
  ]},
  { version: '1.1.2', date: '2026-07-02', notes: [
    'ファビコンを追加',
  ]},
  { version: '1.1.1', date: '2026-07-02', notes: [
    '「ページサイズを統一する」設定使用時などにPDFネイティブ出力経路で発生していたエラー（getPageSize/uniformSize未定義）を修正',
    '印刷失敗時のエラー表示をブラウザのalert()から専用モーダルに変更',
  ]},
  { version: '1.1.0', date: '2026-07-02', notes: [
    '印刷機能を追加（選択ページ印刷 / 全ページ印刷 / Ctrl+Pショートカット）',
  ]},
  { version: '1.0.0', date: '—', notes: [
    'ベースライン（ページ編集・OCR・エクスポート等の既存機能一式）',
  ]},
];

// ============================================================
// LIBRARY CHECK — graceful degradation
// ============================================================
(function checkLibs() {
  const miss = [];
  if (typeof pdfjsLib === 'undefined')  miss.push('PDF.js');
  if (typeof PDFLib   === 'undefined')  miss.push('PDF-lib');
  if (typeof Sortable === 'undefined')  miss.push('SortableJS');
  if (typeof Tesseract === 'undefined') miss.push('Tesseract.js');
  if (typeof jsQR      === 'undefined') miss.push('jsQR');
  if (!miss.length) return;
  document.body.innerHTML = `
    <div class="lib-err">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <h2>ライブラリの読み込みに失敗</h2>
      <p>以下のライブラリを読み込めませんでした：<br>
         <strong>${miss.join(' / ')}</strong><br><br>
         インターネット接続を確認してページを再読み込みしてください。</p>
    </div>`;
  throw new Error('Library missing: ' + miss.join(', '));
})();

// THREE.js はオプション (3Dビューア機能) — 読み込み失敗時はグレースフルデグラデーション
const HAS_THREE = typeof THREE !== 'undefined' &&
  typeof THREE.GLTFLoader !== 'undefined' &&
  typeof THREE.OBJLoader  !== 'undefined' &&
  typeof THREE.STLLoader  !== 'undefined' &&
  typeof THREE.OrbitControls !== 'undefined';

// ============================================================
// PDF.JS SETUP
// ============================================================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// cdnjsはディレクトリ内の動的ファイル取得(bcmap等)に非対応なため、jsdelivrを使用
const CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/';
const CMAP_PACKED = true;
const STANDARD_FONT_DATA_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/';

const { PDFDocument, degrees } = PDFLib;

// ============================================================
// CONSTANTS
// ============================================================
const FILE_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#8b5cf6',
  '#ef4444','#06b6d4','#f97316','#84cc16',
  '#ec4899','#14b8a6','#6366f1','#a16207',
];
const THUMB_W       = 148;
const CARD_SIZE_MIN = 60;
const CARD_SIZE_MAX = 4000;
const CARD_SIZE_DEF = 444;
const AREA_RATIO    = 1.35;

// テキスト層に有意なテキストが存在するとみなす最小文字数（空白除き）
const TEXT_LAYER_THRESHOLD = 10;

// ============================================================
// MASONRY LAYOUT — flex-wrap グリッド (全カードの画像エリア高さを統一)
// ============================================================
const MASONRY_GAP  = 16;   // CSS gap と同値 (px)
const MASONRY_PAD  = 16;   // CSS padding と同値 (px)
const CARD_FOOT_H  = 29;   // .pc-foot min-height (px) ※参照用
const CARD_BORDER  = 3;    // 1.5px border × 2辺 (px) ※参照用

let _masonryTimer = null;

/** 60ms デバウンスしてからレイアウト（サムネイル逐次更新時の連続呼び出しを抑制） */
function scheduleMasonry() {
  clearTimeout(_masonryTimer);
  _masonryTimer = setTimeout(layoutMasonry, 60);
}

/**
 * 解像度（実サイズ）に基づいてカード幅を計算する。
 * A4縦幅(595.28pt)を基準とし、サイズの大小をカードの大きさとして視覚的に表現する。
 */
function computeCardW(item) {
  if (!item?.pw || !item?.ph) return S.cardSize;
  const BASE_WIDTH = 595.28; // A4縦のPDF論理幅 (210mm)
  const scale = S.cardSize / BASE_WIDTH;
  const w = item.pw * scale;
  return Math.max(CARD_SIZE_MIN, Math.round(w));
}

/**
 * サムネイルビューのカード幅をアスペクト比に応じて更新する。
 * flex-wrap レイアウトのため position/left/top は不要。
 * 横長ページは cardSize より広いカード幅になるため、視覚的に横長として表示される。
 */
function layoutMasonry() {
  const pc = g('page-container');
  if (!pc || S.view !== 'th') return;

  const containerW = pc.clientWidth;
  if (containerW <= 0) return;

  // absolute 時代のセンチネル要素が残っていれば除去
  pc.querySelector('.masonry-sentinel')?.remove();

  const maxCardW = Math.max(containerW - 2 * MASONRY_PAD, S.cardSize);

  pc.querySelectorAll('.pc').forEach(card => {
    card.style.position = '';
    card.style.left     = '';
    card.style.top      = '';

    if (card.classList.contains('pc-add')) {
      const w = Math.min(S.cardSize, maxCardW);
      card.style.width = w + 'px';
      card.style.minHeight = (w * 1.414) + 'px';
      return;
    }

    const item = S.ws.find(w => w.id === card.dataset.id);
    // アスペクト比が判明していれば実寸ベース、未取得時はデフォルト幅
    const cardW = Math.min(computeCardW(item), maxCardW);
    card.style.width = cardW + 'px';
  });
}

// ============================================================
// STATE & IndexedDB
// ============================================================
const S = {
  files:    new Map(),  // fileId → {id,name,data,pageCount,color}
  jsDocs:   new Map(),  // fileId → pdfjsDocument (for rendering)
  ws:       [],         // [{id,fileId,pageIndex,rotation,thumbnail,pw,ph,cropBox,textContent}]
  sel:      new Set(),  // selected item ids
  view:     'th',       // 'th' | 'li'
  cardSize: CARD_SIZE_DEF,
  sortable: null,
  colorIdx: 0,
  history:  [],
  histIdx:  -1,
};

let _uid = Date.now();
const uid = () => `i${++_uid}`;
const fid = () => `f${++_uid}`;
const g   = id => document.getElementById(id);

const DB = (() => {
  const DB_NAME = 'PDFStudioDB';
  const DB_VER = 1;
  let db = null;
  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = () => reject('DB Error');
    });
  }
  async function saveFile(f) {
    await open();
    return new Promise(res => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id: f.id, name: f.name, data: f.data, pageCount: f.pageCount, color: f.color });
      tx.oncomplete = res;
    });
  }
  async function getFiles() {
    await open();
    return new Promise(res => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').getAll();
      req.onsuccess = () => res(req.result);
    });
  }
  async function saveWorkspace(ws) {
    await open();
    return new Promise(res => {
      const tx = db.transaction('state', 'readwrite');
      // thumbnail と annotation3D.streamBytes は容量節約のため除外（ファイルデータは別途保存済み）
      const cleanWs = ws.map(w => ({
        ...w,
        thumbnail: null,
        annotation3D: w.annotation3D
          ? { format: w.annotation3D.format, size: w.annotation3D.size, streamBytes: null }
          : null,
      }));
      tx.objectStore('state').put({ id: 'ws', data: cleanWs });
      tx.oncomplete = res;
    });
  }
  async function getWorkspace() {
    await open();
    return new Promise(res => {
      const tx = db.transaction('state', 'readonly');
      const req = tx.objectStore('state').get('ws');
      req.onsuccess = () => res(req.result ? req.result.data : null);
    });
  }
  async function clearAll() {
    await open();
    return new Promise(res => {
      const tx = db.transaction(['files', 'state'], 'readwrite');
      tx.objectStore('files').clear();
      tx.objectStore('state').clear();
      tx.oncomplete = res;
    });
  }
  return { saveFile, getFiles, saveWorkspace, getWorkspace, clearAll };
})();

// ============================================================
// UNDO / REDO & AUTO SAVE
// ============================================================
let _dbSaveTimer = null;

function renderHistory() {
  const dd = g('hist-dropdown');
  if (!dd) return;
  dd.innerHTML = '';
  [...S.history].reverse().forEach((h, revIdx) => {
    const idx = S.history.length - 1 - revIdx;
    const el = document.createElement('div');
    el.className = 'hist-item' + (idx === S.histIdx ? ' current' : '');
    const d = new Date(h.time);
    const timeStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    el.innerHTML = `<i class="fa-solid fa-clock-rotate-left hist-icon"></i><span>${h.action}</span><span class="hist-time">${timeStr}</span>`;
    el.addEventListener('click', () => {
      S.histIdx = idx;
      restoreState();
      g('hist-dropdown').classList.add('hidden');
    });
    dd.appendChild(el);
  });
}

function saveState(actionName = '操作') {
  if (S.history.length === 0) {
    S.history.push({ state: S.ws.map(w => ({ ...w })), action: '初期状態', time: Date.now() });
    S.histIdx = 0;
  }
  if (S.histIdx < S.history.length - 1) {
    S.history = S.history.slice(0, S.histIdx + 1);
  }
  S.history.push({ state: S.ws.map(w => ({ ...w })), action: actionName, time: Date.now() });
  S.histIdx++;
  if (S.history.length > 20) {
    S.history.shift();
    S.histIdx--;
  }
  syncUI();
  
  const histDd = g('hist-dropdown');
  if (histDd && !histDd.classList.contains('hidden')) {
    renderHistory();
  }
  
  clearTimeout(_dbSaveTimer);
  _dbSaveTimer = setTimeout(() => {
    DB.saveWorkspace(S.ws).catch(console.error);
  }, 500);
}

function undo() {
  if (S.histIdx > 0) {
    S.histIdx--;
    restoreState();
  }
}

function redo() {
  if (S.histIdx < S.history.length - 1) {
    S.histIdx++;
    restoreState();
  }
}

function restoreState() {
  S.ws = S.history[S.histIdx].state.map(w => ({ ...w }));
  const validIds = new Set(S.ws.map(w => w.id));
  S.sel = new Set([...S.sel].filter(id => validIds.has(id)));
  
  // 復元したアイテムの中でサムネイルが未生成(null)のものは再生成キューに追加する
  S.ws.forEach(item => {
    if (!item.thumbnail) {
      thumbQ(() => genThumb(item));
    }
  });

  renderAll();
}

// ============================================================
// THUMBNAIL QUEUE — max 3 concurrent renders
// ============================================================
const thumbQ = (() => {
  const q = [];
  let run = 0;
  const MAX = 3;
  const next = () => {
    while (run < MAX && q.length) {
      const {fn, res, rej} = q.shift();
      run++;
      fn().then(v => { run--; res(v); next(); })
          .catch(e => { run--; rej(e); next(); });
    }
  };
  return fn => new Promise((res, rej) => { q.push({fn, res, rej}); next(); });
})();

// ============================================================
// FILE LOADING
// ============================================================
async function loadFiles(fileList) {
  const EXT_PDF = ['.pdf', '.jpg', '.jpeg', '.png'];
  const EXT_3D = ['.glb', '.gltf', '.obj', '.stl', '.prc'];
  const files = [...fileList].filter(f => {
    const name = f.name.toLowerCase();
    return EXT_PDF.some(e => name.endsWith(e)) || EXT_3D.some(e => name.endsWith(e));
  });
  if (!files.length) return;

  showProg(0, files.length);
  for (let i = 0; i < files.length; i++) {
    const ext = files[i].name.split('.').pop().toLowerCase();
    if (EXT_3D.map(e => e.slice(1)).includes(ext)) {
      await load3DFile(files[i]);
    } else {
      await loadOne(files[i]);
    }
    showProg(i + 1, files.length);
  }
  hideProg();
  saveState('ファイル読み込み');
  renderAll();
}

async function requestPassword(fileName) {
  return new Promise((resolve) => {
    const overlay = g('password-overlay');
    const input = g('pdf-password-input');
    const errObj = g('password-error');
    
    g('password-filename').textContent = fileName;
    input.value = '';
    errObj.classList.add('hidden');
    overlay.classList.remove('hidden');
    input.focus();

    const cleanup = () => {
      overlay.classList.add('hidden');
      g('password-submit').onclick = null;
      g('password-cancel').onclick = null;
      g('password-close').onclick = null;
      input.onkeydown = null;
    };

    const submit = () => {
      cleanup();
      resolve(input.value);
    };

    const cancel = () => {
      cleanup();
      resolve(null);
    };

    g('password-submit').onclick = submit;
    g('password-cancel').onclick = cancel;
    g('password-close').onclick = cancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') cancel();
    };
  });
}

async function loadOne(file) {
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    let data;
    let fileName = file.name;

    if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
      const imgBuf = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.create();
      let img;
      try {
        img = ext === 'png' ? await pdfDoc.embedPng(imgBuf) : await pdfDoc.embedJpg(imgBuf);
      } catch (e) {
        throw new Error('画像の解析に失敗しました');
      }
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      const pdfBytes = await pdfDoc.save();
      data = new Uint8Array(pdfBytes);
      fileName = fileName.replace(/\.[^/.]+$/, "") + ".pdf";
    } else {
      const buf = await file.arrayBuffer();
      data = new Uint8Array(buf);
    }

    let jsDoc;
    let pw = null;
    
    while(true) {
      try {
        jsDoc = await pdfjsLib.getDocument({
          data: data.slice(0),
          password: pw,
          cMapUrl: CMAP_URL,
          cMapPacked: CMAP_PACKED,
          standardFontDataUrl: STANDARD_FONT_DATA_URL,
          useSystemFonts: true,
          fontExtraProperties: true
        }).promise;
        break;
      } catch (e) {
        if (e.name === 'PasswordException') {
          if (pw !== null) {
            const errObj = g('password-error');
            if(errObj) errObj.classList.remove('hidden');
          }
          pw = await requestPassword(fileName);
          if (pw === null) {
            throw new Error('パスワード入力がキャンセルされました。');
          }
        } else {
          throw e;
        }
      }
    }

    const n     = jsDoc.numPages;
    const id    = fid();
    const color = FILE_COLORS[S.colorIdx++ % FILE_COLORS.length];

    const newFile = { id, name: fileName, data, pageCount: n, color, password: pw };
    S.files.set(id, newFile);
    S.jsDocs.set(id, jsDoc);
    await DB.saveFile(newFile);

    for (let i = 0; i < n; i++) {
      const item = { id: uid(), fileId: id, pageIndex: i, rotation: 0, flipH: false, flipV: false, thumbnail: null, pw: 0, ph: 0, naturalPw: 0, naturalPh: 0, cropBox: null, textContent: null, filters: null };
      S.ws.push(item);
      thumbQ(() => genThumb(item));
    }

    // バックグラウンドで3Dアノテーションを検出（ノンブロッキング）
    PDF3D.detect(id).then(annotations => {
      if (!annotations.length) return;
      annotations.forEach(ann => {
        const item = S.ws.find(w => w.fileId === id && w.pageIndex === ann.pageIdx);
        if (!item) return;
        item.has3D = true;
        item.annotation3D = ann;
        patchThumbDOM(item);            // サムネイルバッジを更新
        renderSidebar();                // サイドバーの件数表示を更新
      });
    }).catch(() => {/* silent */});
  } catch (err) {
    console.error(err);
    alert(`「${file.name}」を読み込めませんでした。\n暗号化されたファイルや未対応の形式の可能性があります。`);
  }
}

// ============================================================
// PDF 内部 3D アノテーション検出
// ============================================================
/**
 * PDFLib の内部オブジェクトに依存しないダックタイピングでヘルパーを定義する。
 * pdf-lib のバージョン差に左右されない堅牢な実装。
 */
const PDF3D = (() => {

  /** オブジェクトが PDF 間接参照かどうかを判定（objectNumber が number型） */
  function isRef(o)   { return o != null && typeof o.objectNumber === 'number'; }
  /** オブジェクトが PDF 配列かどうかを判定（size/get メソッドを持つ） */
  function isArr(o)   { return o != null && typeof o.size === 'function' && typeof o.get === 'function'; }
  /** オブジェクトが PDF 辞書かどうかを判定（get/has メソッドを持つ） */
  function isDict(o)  { return o != null && typeof o.get === 'function' && typeof o.has === 'function'; }
  /** オブジェクトが PDF ストリームかどうかを判定（dict と contents を持つ） */
  function isStream(o){ return o != null && isDict(o.dict) && o.contents != null; }

  function resolve(ctx, obj) {
    if (!obj || !ctx) return obj;
    if (isRef(obj) && typeof ctx.lookup === 'function') return ctx.lookup(obj);
    return obj;
  }

  function getName(pdfName) {
    if (!pdfName) return '';
    if (typeof pdfName.decodeText === 'function') return pdfName.decodeText();
    // PDFName.toString() returns "/Name" — strip leading slash
    const s = pdfName.toString();
    return s.startsWith('/') ? s.slice(1) : s;
  }

  /**
   * PDF ファイル内のすべてのページを走査し、/Subtype /3D のアノテーションを検出する。
   * @returns {Promise<Array<{pageIdx, format, streamBytes, size}>>}
   */
  async function detect(fileId) {
    const file = S.files.get(fileId);
    if (!file?.data) return [];

    const results = [];
    let pdfDoc;
    try {
      pdfDoc = await PDFDocument.load(file.data.slice(0), {
        password: file.password,
        ignoreEncryption: true,
        updateMetadata:   false,
      });
    } catch (e) {
      return [];
    }

    const ctx       = pdfDoc.context;
    const pageCount = pdfDoc.getPageCount();

    for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
      try {
        const page     = pdfDoc.getPage(pageIdx);
        const pageDict = page.node;

        // /Annots を取得
        const annotsKey = PDFLib.PDFName.of('Annots');
        if (!isDict(pageDict) || !pageDict.has(annotsKey)) continue;
        const annotsRaw = pageDict.get(annotsKey);
        const annotsArr = resolve(ctx, annotsRaw);
        if (!isArr(annotsArr)) continue;

        for (let i = 0; i < annotsArr.size(); i++) {
          const annotRaw  = annotsArr.get(i);
          const annotDict = resolve(ctx, annotRaw);
          if (!isDict(annotDict)) continue;

          // /Subtype が /3D であるか確認
          const subtypeKey = PDFLib.PDFName.of('Subtype');
          if (!annotDict.has(subtypeKey)) continue;
          const subtypeName = getName(annotDict.get(subtypeKey));
          if (subtypeName !== '3D') continue;

          // 3D アノテーション発見 —— /3DD ストリームを取得
          let format      = 'Unknown';
          let streamBytes = null;

          const streamKey = PDFLib.PDFName.of('3DD');
          if (annotDict.has(streamKey)) {
            const streamRaw = annotDict.get(streamKey);
            const streamObj = resolve(ctx, streamRaw);

            if (isStream(streamObj)) {
              // /Subtype から U3D / PRC を判定
              const fmtKey = PDFLib.PDFName.of('Subtype');
              if (streamObj.dict.has(fmtKey)) {
                format = getName(streamObj.dict.get(fmtKey)) || 'Unknown';
              }
              // ── ストリーム展開: decode()失敗時にzlib展開と raw フォールバックを試みる ──
              try {
                if (typeof streamObj.decode === 'function') {
                  streamBytes = streamObj.decode();
                }
              } catch { /* decode失敗: 後続フォールバックへ */ }

              // decode()が空または失敗 → raw contentsを取得してzlib展開を試みる
              if (!streamBytes || streamBytes.length === 0) {
                const raw = streamObj.contents instanceof Uint8Array
                  ? streamObj.contents : null;
                if (raw && raw.length > 0) {
                  // zlib展開を試みる（非同期）
                  const decompressed = await tryDecompressZlib(raw);
                  streamBytes = (decompressed && decompressed.length > raw.length / 2)
                    ? decompressed : raw;
                }
              } else {
                // decode()成功でもデータがzlibヘッダーを持つ場合は追加展開を試みる
                const decompressed = await tryDecompressZlib(streamBytes);
                if (decompressed && decompressed.length > streamBytes.length / 2) {
                  streamBytes = decompressed;
                }
              }
            }
          }

          // /Contents （説明文）
          let description = '';
          const contKey = PDFLib.PDFName.of('Contents');
          if (annotDict.has(contKey)) {
            const contVal = annotDict.get(contKey);
            if (contVal && typeof contVal.decodeText === 'function') {
              description = contVal.decodeText();
            } else if (contVal) {
              description = contVal.toString();
            }
          }

          results.push({
            pageIdx,
            format,
            streamBytes,
            size:        streamBytes?.length ?? 0,
            description,
          });
        }
      } catch { /* ページ個別のエラーはスキップ */ }
    }

    return results;
  }

  /**
   * zlib/deflate マジックバイトを持つデータを DecompressionStream で展開する。
   * 展開に失敗した場合は null を返す（非同期）。
   */
  async function tryDecompressZlib(bytes) {
    if (!bytes || bytes.length < 4 || typeof DecompressionStream === 'undefined') return null;
    const b0 = bytes[0], b1 = bytes[1];
    // gzip: 1F 8B
    const isGzip = b0 === 0x1F && b1 === 0x8B;
    // zlib: 78 01 / 78 5E / 78 9C / 78 DA
    const isZlib = b0 === 0x78 && (b1 === 0x01 || b1 === 0x5E || b1 === 0x9C || b1 === 0xDA);
    if (!isGzip && !isZlib) return null;
    try {
      const fmt    = isGzip ? 'gzip' : 'deflate';
      const input  = isZlib ? bytes.slice(2) : bytes; // zlib は 2バイトのヘッダーをスキップ
      const ds     = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(input);
      writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total  = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { result.set(c, off); off += c.length; }
      return result.length > 0 ? result : null;
    } catch { return null; }
  }

  /** フォーマット文字列からファイル拡張子を返す */
  function ext(format) {
    const map = { U3D: 'u3d', PRC: 'prc' };
    return map[format?.toUpperCase()] || 'bin';
  }

  /** フォーマットに対応するソフトウェア情報を返す */
  function compatInfo(format) {
    const f = (format || '').toUpperCase();
    if (f === 'U3D') return 'U3D (Universal 3D) 形式 — Adobe Acrobat / Acrobat Reader で3Dビューを表示できます。';
    if (f === 'PRC') return 'PRC (Product Representation Compact) 形式 — Adobe Acrobat Pro / CATIA / SolidWorks などで表示できます。';
    return '形式不明 — 対応ビューアをご確認ください。';
  }

  return { detect, ext, compatInfo, tryDecompressZlib };
})();

// ============================================================
// PRC BINARY PARSER — Improved Fuzzy Tessellation Extractor
// ============================================================
/**
 * PRC/U3Dバイナリからヒューリスティックに頂点データを抽出する改良版ファジーパーサー。
 *
 * 改善点:
 *   - O(N²) → O(N) の単一パス走査（バイトオフセット 0-3 を4回試行）
 *   - 座標範囲チェックを大幅緩和（1e-6〜1e7 → 絶対値 < 1e12）
 *   - 不正値連続許容数を 2→6 に拡大（圧縮アーティファクト耐性向上）
 *   - 上位 MAX_BLOCKS 個のブロックを結合（1ブロックだけの採用を廃止）
 *   - スパゲッティ除去を 90パーセンタイル基準に変更（外れ値耐性向上）
 *   - inspect() が失敗しても parse() を呼び出せるよう設計を統一
 */
const PRCParser = (() => {

  const MIN_FLOATS  = 9;   // 三角形1個（3頂点×3成分）
  const MAX_BAD_RUN = 6;   // 連続する不正値の許容数（圧縮アーティファクト対策）
  const MAX_BLOCKS  = 6;   // 結合するブロックの最大数

  /** 座標値として許容できるかの判定（極端な値のみ除外・大幅緩和） */
  function _isValid(v) { return isFinite(v) && !isNaN(v) && Math.abs(v) < 1e12; }

  /**
   * 単一パスで連続する有効フロートのブロックを収集する O(N)
   * @param {Uint8Array} buf
   * @param {number}     byteStart  スキャン開始バイトオフセット (0-7)
   * @param {boolean}    isFloat64
   * @returns {Array<{byteOffset, count, isFloat64}>}
   */
  function _scanBlocks(buf, byteStart, isFloat64) {
    const bpf = isFloat64 ? 8 : 4;
    const dv  = new DataView(buf.buffer, buf.byteOffset);
    const len = Math.floor((buf.byteLength - byteStart) / bpf);
    if (len < MIN_FLOATS) return [];

    const blocks = [];
    let bStart = -1, count = 0, badRun = 0;

    const flush = () => {
      if (bStart < 0 || count < MIN_FLOATS) return;
      const vc = Math.floor(count / 3) * 3;
      if (vc >= MIN_FLOATS)
        blocks.push({ byteOffset: byteStart + bStart * bpf, count: vc, isFloat64 });
    };

    for (let i = 0; i < len; i++) {
      const bo = byteStart + i * bpf;
      const v  = isFloat64 ? dv.getFloat64(bo, true) : dv.getFloat32(bo, true);
      if (_isValid(v)) {
        if (bStart < 0) bStart = i;
        count++;
        badRun = 0;
      } else {
        if (++badRun > MAX_BAD_RUN) {
          count = Math.max(0, count - (badRun - 1));
          flush();
          bStart = -1; count = 0; badRun = 0;
        }
      }
    }
    flush();
    return blocks;
  }

  /**
   * Float32（開始オフセット 0〜3）と Float64（0,4）を全パターン試行して
   * 全ブロックを収集する。合計 6 パス × O(N) = O(6N) の線形処理。
   */
  function _collectBlocks(buf) {
    const all = [];
    for (let o = 0; o < 4; o++)        _scanBlocks(buf, o, false).forEach(b => all.push(b));
    for (let o = 0; o < 8; o += 4)     _scanBlocks(buf, o, true).forEach(b => all.push(b));
    return all;
  }

  /** 重複ブロックを除去してカウント降順にソート */
  function _dedup(blocks) {
    blocks.sort((a, b) => b.count - a.count);
    const result = [];
    for (const c of blocks) {
      const bpf = c.isFloat64 ? 8 : 4;
      const cEnd = c.byteOffset + c.count * bpf;
      const dup  = result.some(m => {
        const mEnd = m.byteOffset + m.count * (m.isFloat64 ? 8 : 4);
        return Math.max(c.byteOffset, m.byteOffset) < Math.min(cEnd, mEnd);
      });
      if (!dup) result.push(c);
    }
    return result;
  }

  /**
   * 90 パーセンタイル基準でスパゲッティ三角形（異常な長辺）を潰す。
   * 従来の中央値×400 より外れ値に強く、過剰な除去を防ぐ。
   */
  function _removeSpaghetti(pos) {
    const triCount = Math.floor(pos.length / 9);
    if (triCount < 2) return;

    const step   = Math.max(1, Math.floor(triCount / 1000));
    const lsqArr = [];
    for (let i = 0; i < triCount; i += step) {
      const b = i * 9;
      for (let e = 0; e < 3; e++) {
        const p1 = b + e * 3, p2 = b + ((e + 1) % 3) * 3;
        if (p2 + 2 >= pos.length) continue;
        const dx = pos[p1] - pos[p2], dy = pos[p1+1] - pos[p2+1], dz = pos[p1+2] - pos[p2+2];
        const lsq = dx*dx + dy*dy + dz*dz;
        if (lsq > 0) lsqArr.push(lsq);
      }
    }
    if (lsqArr.length < 3) return;
    lsqArr.sort((a, b) => a - b);
    const thresh = lsqArr[Math.floor(lsqArr.length * 0.9)] * 100;

    for (let i = 0; i < triCount; i++) {
      const b = i * 9;
      let bad = false;
      for (let e = 0; e < 3 && !bad; e++) {
        const p1 = b + e * 3, p2 = b + ((e + 1) % 3) * 3;
        if (p2 + 2 >= pos.length) continue;
        const dx = pos[p1] - pos[p2], dy = pos[p1+1] - pos[p2+1], dz = pos[p1+2] - pos[p2+2];
        if (dx*dx + dy*dy + dz*dz > thresh) bad = true;
      }
      if (bad) for (let k = 0; k < 9; k++) pos[b + k] = 0;
    }
  }

  /**
   * 上位 MAX_BLOCKS 個のブロックを Float32Array に結合して返す。
   *
   * ⚠ ブロック内には MAX_BAD_RUN 以内の不正値（NaN/Inf）が混在している。
   * それらを 0 に置換することで Three.js computeBoundingSphere の NaN クラッシュを防ぐ。
   */
  function _buildPositions(buf, blocks) {
    const sel   = blocks.slice(0, MAX_BLOCKS);
    const total = sel.reduce((s, b) => s + b.count, 0);
    const pos   = new Float32Array(total); // デフォルト 0 初期化
    const dv    = new DataView(buf.buffer, buf.byteOffset);
    let wp = 0;
    for (const bl of sel) {
      const bpf     = bl.isFloat64 ? 8 : 4;
      const maxRead = Math.min(bl.count, Math.floor((buf.byteLength - bl.byteOffset) / bpf));
      for (let i = 0; i < maxRead; i++) {
        const v = bl.isFloat64
          ? dv.getFloat64(bl.byteOffset + i * bpf, true)
          : dv.getFloat32(bl.byteOffset + i * bpf, true);
        pos[wp++] = _isValid(v) ? v : 0; // NaN/Inf → 0 に置換
      }
      wp += bl.count - maxRead; // バッファ短不足分は 0 のまま
    }
    return pos;
  }

  /** ブロック候補を返す共通処理 */
  function _getBlocks(prcBytes) {
    return _dedup(_collectBlocks(prcBytes));
  }

  function parse(prcBytes) {
    if (!HAS_THREE || !prcBytes || prcBytes.byteLength < 36) return null;
    try {
      const blocks = _getBlocks(prcBytes);
      if (!blocks.length) return null;

      const pos = _buildPositions(prcBytes, blocks);
      _removeSpaghetti(pos);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();

      const box = geometry.boundingBox;
      if (!box || !isFinite(box.min.x)) return null;

      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim < 1e-14 || maxDim > 1e14) return null;

      geometry.center();
      return geometry;
    } catch { return null; }
  }

  /** 点群ジオメトリとして返す（最終フォールバック用） */
  function parseAsPoints(prcBytes) {
    if (!HAS_THREE || !prcBytes || prcBytes.byteLength < 36) return null;
    try {
      const blocks = _getBlocks(prcBytes);
      if (!blocks.length) return null;
      const pos = _buildPositions(prcBytes, blocks);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box || !isFinite(box.min.x)) return null;
      const size = new THREE.Vector3();
      box.getSize(size);
      if (Math.max(size.x, size.y, size.z) < 1e-14) return null;
      geometry.center();
      return geometry;
    } catch { return null; }
  }

  function inspect(prcBytes) {
    if (!prcBytes || prcBytes.byteLength < 36)
      return { ok: false, reason: 'データが短すぎます' };
    try {
      const blocks = _getBlocks(prcBytes);
      if (!blocks.length)
        return { ok: false, reason: '表示可能な頂点データが見つかりません' };
      const total = blocks.slice(0, MAX_BLOCKS).reduce((s, b) => s + b.count, 0);
      return {
        ok:          true,
        vertexCount: Math.floor(total / 3),
        triCount:    Math.floor(total / 9),
        hasNormal:   false,
        blockCount:  blocks.length,
        isFloat64:   blocks[0].isFloat64,
      };
    } catch {
      return { ok: false, reason: '解析中にエラーが発生しました' };
    }
  }

  return { parse, inspect, parseAsPoints };
})();

// ============================================================
// PDF 3D 情報パネル (Viewer内)
// ============================================================
const PDF3DPanel = (() => {
  let _currentBlob = null;

  /**
   * Three.js キャンバスにメッシュ or 点群を表示する共通ヘルパー。
   * @param {THREE.Object3D} obj     - Mesh または Points
   * @param {HTMLElement}    canvas
   * @param {string}         key
   * @param {string}         label   - ツールバーに表示するラベル
   * @param {object}         item
   * @param {object}         ann
   * @param {string}         fmt
   */
  function _showIn3DPanel(obj, canvas, key, label, item, ann, fmt) {
    const info    = g('pdf-3d-info');
    const toolbar = g('viewer-3d-toolbar');
    const dlBtn   = g('pdf-3d-dl');

    if (!canvas || !obj) return false;

    info?.classList.add('hidden');
    canvas.style.display = '';
    if (toolbar) toolbar.style.display = '';

    ThreeViewer.showMesh(canvas, obj, key);

    const fnEl = g('viewer-3d-filename');
    if (fnEl) {
      const f = S.files.get(item.fileId);
      fnEl.textContent = (f?.name || '') + `  [${label}]`;
    }

    if (dlBtn && ann?.streamBytes?.length > 0) {
      if (_currentBlob) URL.revokeObjectURL(_currentBlob);
      const blob = new Blob([ann.streamBytes], { type: 'application/octet-stream' });
      _currentBlob = URL.createObjectURL(blob);
      const f = S.files.get(item.fileId);
      const baseName = (f?.name || 'page').replace(/\.pdf$/i, '') + `_3d_p${item.pageIndex + 1}`;
      dlBtn.style.display = '';
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = _currentBlob; a.download = `${baseName}.${PDF3D.ext(fmt)}`;
        a.click();
      };
    }
    return true;
  }

  /** 3D表示失敗時のフォールバック情報パネル */
  function _showFallback(item, ann, fmt, reason) {
    const canvas  = g('viewer-3d-canvas');
    const info    = g('pdf-3d-info');
    const toolbar = g('viewer-3d-toolbar');
    const metaEl  = g('pdf-3d-meta');
    const compatEl = g('pdf-3d-compat');
    const dlBtn   = g('pdf-3d-dl');

    ThreeViewer.stop();
    if (canvas)  canvas.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    info?.classList.remove('hidden');

    if (!ann) {
      if (metaEl) metaEl.innerHTML = '3Dデータの詳細を取得できませんでした';
      if (compatEl) compatEl.textContent = '';
      return;
    }

    const sizeFmt = ann.size > 0 ? `${(ann.size / 1024).toFixed(1)} KB` : '不明';
    if (metaEl) metaEl.innerHTML = `
      <div class="p3d-row"><span class="p3d-lbl">フォーマット</span><span class="p3d-fmt">${fmt}</span></div>
      <div class="p3d-row"><span class="p3d-lbl">データサイズ</span><span>${sizeFmt}</span></div>
      ${ann.description ? `<div class="p3d-row"><span class="p3d-lbl">説明</span><span>${ann.description}</span></div>` : ''}`;
    if (compatEl) {
      compatEl.textContent = reason
        || `3D形式 (${fmt}) ですが、表示用メッシュデータを抽出できませんでした。ダウンロードしてAcrobat等で開いてください。`;
    }

    if (dlBtn) {
      if (ann.streamBytes?.length > 0) {
        if (_currentBlob) URL.revokeObjectURL(_currentBlob);
        const blob = new Blob([ann.streamBytes], { type: 'application/octet-stream' });
        _currentBlob = URL.createObjectURL(blob);
        const f = S.files.get(item.fileId);
        const baseName = (f?.name || 'page').replace(/\.pdf$/i, '') + `_3d_p${item.pageIndex + 1}`;
        dlBtn.style.display = '';
        dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = _currentBlob; a.download = `${baseName}.${PDF3D.ext(fmt)}`;
          a.click();
        };
      } else {
        dlBtn.style.display = 'none';
      }
    }
  }

  /**
   * 3D パネルを開く（非同期）。
   * 処理順序:
   *   1. zlib 二重圧縮を検出して展開
   *   2. PRCParser.parse() でメッシュ生成（MeshStandardMaterial + FlatShading）
   *   3. 失敗時: PRCParser.parseAsPoints() で点群表示（フォールバック）
   *   4. それも失敗: 情報パネル表示
   */
  async function show(item) {
    const ann    = item?.annotation3D;
    const canvas = g('viewer-3d-canvas');
    const info   = g('pdf-3d-info');

    if (!info) return;
    if (!ann) { _showFallback(item, null, '', null); return; }

    const fmt = ann.format || 'Unknown';

    // ストリームが空なら即フォールバック
    if (!ann.streamBytes || ann.streamBytes.length === 0 || !HAS_THREE) {
      if (!HAS_THREE)
        g('pdf-3d-compat') && (g('pdf-3d-compat').textContent = PDF3D.compatInfo(fmt));
      _showFallback(item, ann, fmt,
        !HAS_THREE ? PDF3D.compatInfo(fmt) : '3Dデータが空です。ダウンロードしてAcrobat等で開いてください。');
      return;
    }

    // ── Step 1: zlib 二重圧縮の検出・展開 ──
    let bytes = ann.streamBytes;
    const decompressed = await PDF3D.tryDecompressZlib(bytes);
    if (decompressed && decompressed.length > bytes.length / 2) bytes = decompressed;

    // ── Step 2: Triangle Soup メッシュとして表示を試みる ──
    const geometry = PRCParser.parse(bytes);
    if (geometry) {
      const inspectR = PRCParser.inspect(bytes);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x8bc4f0, roughness: 0.45, metalness: 0.25,
        side: THREE.DoubleSide, flatShading: true,
      });
      const mesh = new THREE.Mesh(geometry, mat);
      const label = `ファジー抽出 — ${(inspectR.ok ? inspectR.vertexCount : '?').toLocaleString()} 頂点`;
      _showIn3DPanel(mesh, canvas, item.fileId + '_3d', label, item, ann, fmt);
      return;
    }

    // ── Step 3: 点群として表示を試みる（最終フォールバック） ──
    const ptGeom = PRCParser.parseAsPoints(bytes);
    if (ptGeom) {
      const ptMat  = new THREE.PointsMaterial({ color: 0x8bc4f0, size: 0.015, sizeAttenuation: true });
      const points = new THREE.Points(ptGeom, ptMat);
      const ptCount = ptGeom.attributes.position.count;
      _showIn3DPanel(points, canvas, item.fileId + '_3d_pts',
        `点群表示 — ${ptCount.toLocaleString()} 点`, item, ann, fmt);
      return;
    }

    // ── Step 4: 完全失敗 → 情報パネル ──
    _showFallback(item, ann, fmt,
      `3D形式 (${fmt}) ですが、表示用メッシュデータを抽出できませんでした。` +
      `ダウンロードしてAcrobat等で開いてください。`);
  }

  function hide() {
    const canvas = g('viewer-3d-canvas');
    const info   = g('pdf-3d-info');
    const toolbar= g('viewer-3d-toolbar');
    if (canvas)  canvas.style.display = '';
    if (info)    info.classList.add('hidden');
    if (toolbar) toolbar.style.display = '';
  }

  return { show, hide };
})();

// ============================================================
// 3D FILE LOADING
// ============================================================
async function load3DFile(file) {
  if (!HAS_THREE) {
    alert('Three.jsが読み込めないため、3Dファイルを開けません。\nインターネット接続を確認してページを再読み込みしてください。');
    return;
  }
  try {
    const buf  = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    const ext  = file.name.split('.').pop().toLowerCase();
    const id   = fid();
    const color = '#7c3aed';

    const newFile = { id, name: file.name, data, pageCount: 1, color, fileType: '3d', ext };
    S.files.set(id, newFile);

    const item = {
      id: uid(), fileId: id, type: '3d',
      pageIndex: 0, rotation: 0, flipH: false, flipV: false,
      thumbnail: null, pw: 300, ph: 300,
      naturalPw: 300, naturalPh: 300,
      cropBox: null, textContent: null, filters: null
    };
    S.ws.push(item);
    thumbQ(() => gen3DThumb(item));
    await DB.saveFile(newFile);
  } catch (err) {
    console.error(err);
    alert(`「${file.name}」を読み込めませんでした。`);
  }
}

async function gen3DThumb(item) {
  if (!HAS_THREE) return;
  const fileData = S.files.get(item.fileId);
  if (!fileData) return;

  try {
    const cnv = document.createElement('canvas');
    cnv.width = 300; cnv.height = 300;

    const renderer = new THREE.WebGLRenderer({ canvas: cnv, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(300, 300, false);
    renderer.setClearColor(0x1b2438, 1);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dl = new THREE.DirectionalLight(0xffffff, 0.9);
    dl.position.set(3, 5, 3); scene.add(dl);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(3, 2, 3);

    const obj = await load3DModel(fileData);
    if (!obj) { renderer.dispose(); return; }
    scene.add(obj);

    // Auto-fit
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist   = maxDim * 2.0;
    camera.position.set(center.x + dist, center.y + dist * 0.6, center.z + dist);
    camera.lookAt(center);

    // モデルやマテリアルの初期化を確実に反映させるため少し待機
    await new Promise(r => setTimeout(r, 100));
    renderer.render(scene, camera);
    item.thumbnail = cnv.toDataURL('image/jpeg', 0.85);

    // Cleanup
    renderer.dispose();
    obj.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); [o.material].flat().forEach(m => m?.dispose()); } });

    patchThumbDOM(item);
  } catch { /* silent */ }
}

/**
 * 3Dモデルデータを THREE.js オブジェクトとして返す (Promise)
 */
function load3DModel(fileData) {
  return new Promise((resolve) => {
    const { ext, data } = fileData;
    const blob    = new Blob([data], { type: getMimeType(ext) });
    const url     = URL.createObjectURL(blob);
    const cleanup = () => URL.revokeObjectURL(url);

    if (ext === 'glb' || ext === 'gltf') {
      const loader = new THREE.GLTFLoader();
      loader.load(url, gltf => {
        cleanup();
        resolve(gltf.scene);
      }, undefined, () => { cleanup(); resolve(null); });
    } else if (ext === 'obj') {
      const loader = new THREE.OBJLoader();
      loader.load(url, obj => {
        cleanup();
        // OBJ はマテリアルなしのことが多いので簡易マテリアルを割り当て
        obj.traverse(o => {
          if (o.isMesh && !o.material.color) {
            o.material = new THREE.MeshStandardMaterial({ color: 0x8bc4f0, roughness: 0.6, metalness: 0.2 });
          }
        });
        resolve(obj);
      }, undefined, () => { cleanup(); resolve(null); });
    } else if (ext === 'stl') {
      const loader = new THREE.STLLoader();
      loader.load(url, geometry => {
        cleanup();
        geometry.computeVertexNormals();
        const mat  = new THREE.MeshStandardMaterial({ color: 0x8bc4f0, roughness: 0.5, metalness: 0.3 });
        resolve(new THREE.Mesh(geometry, mat));
      }, undefined, () => { cleanup(); resolve(null); });
    } else if (ext === 'prc') {
      // PRCファイル単体ロード（PDF埋め込みではなく .prc ファイル直接読み込み）
      cleanup(); // BlobURLは不要（バイナリを直接使用）
      if (!HAS_THREE) { resolve(null); return; }
      try {
        // Step1: Triangle Soup メッシュとして表示
        const geometry = PRCParser.parse(data);
        if (geometry) {
          const mat = new THREE.MeshStandardMaterial({
            color: 0x8bc4f0, roughness: 0.45, metalness: 0.25,
            side: THREE.DoubleSide, flatShading: true,
          });
          resolve(new THREE.Mesh(geometry, mat));
          return;
        }
        // Step2: 点群として表示（フォールバック）
        const ptGeom = PRCParser.parseAsPoints(data);
        if (ptGeom) {
          const ptMat = new THREE.PointsMaterial({ color: 0x8bc4f0, size: 0.015, sizeAttenuation: true });
          resolve(new THREE.Points(ptGeom, ptMat));
          return;
        }
        resolve(null);
      } catch { resolve(null); }
    } else {
      cleanup();
      resolve(null);
    }
  });
}

function getMimeType(ext) {
  return { glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', stl: 'model/stl' }[ext] || 'application/octet-stream';
}

async function removeFile(fileId) {
  // 3Dビューアが表示中でこのファイルを使用していれば停止
  ThreeViewer.stopIfFile(fileId);
  S.ws = S.ws.filter(w => w.fileId !== fileId);
  S.sel.forEach(id => { if (!S.ws.find(w => w.id === id)) S.sel.delete(id); });
  saveState();
  renderAll();
}

// ============================================================
// THUMBNAIL GENERATION
// ============================================================
function getFilterString(filters) {
  if (!filters) return 'none';
  const { br = 100, ct = 100, sa = 100, bl = 0 } = filters;
  if (br === 100 && ct === 100 && sa === 100 && bl === 0) return 'none';
  return `brightness(${br}%) contrast(${ct}%) saturate(${sa}%) blur(${bl}px)`;
}

async function genThumb(item) {
  if (item.type === '3d') { gen3DThumb(item); return; }
  const jsDoc = S.jsDocs.get(item.fileId);
  if (!jsDoc) return;
  try {
    const page     = await jsDoc.getPage(item.pageIndex + 1);

    if (!item.naturalPw) {
      const naturalVp   = page.getViewport({ scale: 1 });
      item.naturalPw    = Math.round(naturalVp.width);
      item.naturalPh    = Math.round(naturalVp.height);
      item.pageRotate   = page.rotate || 0;  // PDFが持つ組み込み回転角を保存
    }

    const totalRot = (page.rotate + item.rotation) % 360;
    const dpr      = Math.min(window.devicePixelRatio || 1, 2);
    
    let baseW, baseH;
    if (item.scanFixData) {
      const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
      const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
      if (item.rotation === 90 || item.rotation === 270) {
        baseW = lh;
        baseH = lw;
      } else {
        baseW = lw;
        baseH = lh;
      }
    } else {
      const vp0 = page.getViewport({ scale: 1, rotation: totalRot });
      baseW = vp0.width;
      baseH = vp0.height;
    }

    item.pw = Math.round(baseW);
    item.ph = Math.round(baseH);
    
    // 表示幅（横長ページは cardSize より広い）に合わせた解像度でレンダリング
    const targetW  = Math.round(computeCardW(item) * dpr);
    const sc       = targetW / baseW;
    
    const canvas   = document.createElement('canvas');
    canvas.width   = Math.round(baseW * sc);
    canvas.height  = Math.round(baseH * sc);

    if (item.scanFixData) {
      const img = new Image();
      img.src = item.scanFixData.dataUrl;
      await new Promise(r => { img.onload = r; });
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(item.rotation * Math.PI / 180);
      const _lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
      const _lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
      ctx.drawImage(img, -_lw * sc / 2, -_lh * sc / 2, _lw * sc, _lh * sc);
      ctx.restore();
    } else {
      const vp = page.getViewport({ scale: sc, rotation: totalRot });
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
    
    const filterStr = getFilterString(item.filters);
    if (filterStr !== 'none') {
      const fCnv = document.createElement('canvas');
      fCnv.width = canvas.width; fCnv.height = canvas.height;
      const fCtx = fCnv.getContext('2d');
      fCtx.filter = filterStr;
      fCtx.drawImage(canvas, 0, 0);
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      canvas.getContext('2d').drawImage(fCnv, 0, 0);
    }

    // 反転処理（paint合成前に行う）
    applyFlipToCanvas(canvas, item);

    if (item.paintData) {
      const img = new Image();
      img.src = item.paintData.dataUrl;
      await new Promise(r => { img.onload = r; });
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    }

    if (item.cropBox) {
      const { x, y, width, height } = item.cropBox;
      const cw = canvas.width, ch = canvas.height;
      const cx = cw * x, cy = ch * y, cw2 = cw * width, ch2 = ch * height;
      const cropCnv = document.createElement('canvas');
      cropCnv.width = Math.max(1, cw2); cropCnv.height = Math.max(1, ch2);
      cropCnv.getContext('2d').drawImage(canvas, cx, cy, cw2, ch2, 0, 0, cw2, ch2);
      item.pw = cw2 / dpr; item.ph = ch2 / dpr; 
      item.thumbnail = cropCnv.toDataURL('image/jpeg', 0.88);
    } else {
      item.thumbnail = canvas.toDataURL('image/jpeg', 0.88);
    }
    
    patchThumbDOM(item);
  } catch { /* silent */ }
}

function patchThumbDOM(item) {
  const wrap = document.querySelector(`[data-id="${item.id}"]`);
  if (!wrap) return;
  const area = wrap.querySelector('.pc-area');
  if (!area) return;

  const badges = [];
  if (item.cropBox) badges.push(`<span class="badge-crop" title="クロップ適用中"><i class="fa-solid fa-crop-simple"></i></span>`);
  if (item.scanFixData) badges.push(`<span class="badge-scanfix" title="スキャン補正適用中"><i class="fa-solid fa-object-ungroup"></i></span>`);
  if (item.paintData) badges.push(`<span class="badge-paint" title="ペイント適用中"><i class="fa-solid fa-paintbrush"></i></span>`);
  if (item.filters && getFilterString(item.filters) !== 'none') badges.push(`<span class="badge-filter" title="画像調整適用中"><i class="fa-solid fa-sliders"></i></span>`);
  if (item.flipH || item.flipV) badges.push(`<span class="badge-flip" title="反転適用中"><i class="fa-solid fa-left-right"></i></span>`);
  if (item.textContent) badges.push(`<span class="badge-ocr" title="テキスト抽出済み"><i class="fa-solid fa-language"></i></span>`);
  if (item.has3D) badges.push(`<span class="badge-3d" title="3Dデータを含む"><i class="fa-solid fa-cube"></i></span>`);
  const statusBadges = badges.length ? `<div class="pc-status-badges">${badges.join('')}</div>` : '';

  if (item.type === '3d') {
    const f = S.files.get(item.fileId);
    area.innerHTML = statusBadges + (item.thumbnail
      ? `<img class="ti" src="${item.thumbnail}" alt="">`
      : `<div class="pc-3d-icon"><i class="fa-solid fa-cube"></i><span>${(f?.ext || '3D').toUpperCase()}</span></div>`);
  } else {
    const rotCls = item.rotation !== 0 ? 'pc-rot-badge visible' : 'pc-rot-badge';
    const imgTag = item.thumbnail ? `<img class="ti" src="${item.thumbnail}" alt="">` : '';
    area.innerHTML = `<div class="${rotCls}"><i class="fa-solid fa-rotate"></i> ${item.rotation}°</div>${statusBadges}${imgTag}`;
    applyRot(area, item);
  }
  scheduleMasonry();
}

function applyRot(area, item) {
  if (!area) return;
  // style.aspectRatio 直接代入でブラウザ再計算を確実にトリガー
  const w = item.pw || item.naturalPw || 210;
  const h = item.ph || item.naturalPh || 297;
  area.style.aspectRatio = `${w} / ${h}`;
}

// ============================================================
// CARD SIZE (thumbnail view)
// ============================================================
let _thumbResizeTimer = null;
let _lastThumbCardW   = CARD_SIZE_DEF;

function setCardSize(val) {
  S.cardSize = Math.max(CARD_SIZE_MIN, Math.min(val, CARD_SIZE_MAX));
  const sl = g('size-slider');
  if (sl && Number(sl.value) !== S.cardSize) sl.value = S.cardSize;
  const sv = g('size-val');
  if (sv) {
    // 148pxを基準(100%)とした相対スケールパーセント
    const pct = Math.round((S.cardSize / 148) * 100);
    sv.textContent = pct + '%';
  }

  // ドラッグ中も即時レイアウトを更新し、CSS --card-w による一律化（サイズ崩れ）を防ぐ
  layoutMasonry();

  clearTimeout(_thumbResizeTimer);
  _thumbResizeTimer = setTimeout(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (S.cardSize * dpr > _lastThumbCardW * dpr * 1.25 && S.ws.length && S.view === 'th') {
      _lastThumbCardW = S.cardSize;
      S.ws.forEach(item => thumbQ(() => genThumb(item)));
    }
  }, 500);
}

function applyThumbnailFit(mode) {
  if (S.view !== 'th' || !S.ws.length) return;
  const pc = g('page-container');
  if (!pc) return;

  // 選択中アイテム、または先頭のアイテムを基準にする
  const refId = S.sel.size > 0 ? [...S.sel][0] : S.ws[0].id;
  const item = S.ws.find(w => w.id === refId);
  if (!item) return;

  const pw = item.pw || item.naturalPw || 210;
  const ph = item.ph || item.naturalPh || 297;

  let targetCardW;
  const pad = MASONRY_PAD * 2;
  const maxW = pc.clientWidth - pad;
  const maxH = pc.clientHeight - pad;

  if (mode === 'w') {
    targetCardW = maxW;
  } else if (mode === 'h') {
    targetCardW = maxH * (pw / ph);
  } else if (mode === '100') {
    targetCardW = pw;
  }

  if (!targetCardW) return;

  // 基準幅(A4縦幅:595.28)に対する相対スケールから S.cardSize を逆算
  const BASE_WIDTH = 595.28;
  const newSize = Math.round(targetCardW * (BASE_WIDTH / pw));
  setCardSize(newSize);
}

// ============================================================
// PAGE OPERATIONS
// ============================================================
async function addBlankPage() {
  showProg(0, 1, '白紙を作成中');
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 (210x297mm)
    
    const { width, height } = page.getSize();
    // 罫線（方眼）を描画する (視覚的なアクセント)
    for (let y = 40; y < height - 40; y += 20) {
      page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: PDFLib.rgb(0.85, 0.85, 0.85) });
    }
    
    const pdfBytes = await pdfDoc.save();
    const data = new Uint8Array(pdfBytes);
    
    const jsDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    const id = fid();
    const color = '#94a3b8';
    
    S.files.set(id, { id, name: 'Blank Page.pdf', data, pageCount: 1, color });
    S.jsDocs.set(id, jsDoc);
    
    const item = { id: uid(), fileId: id, pageIndex: 0, rotation: 0, flipH: false, flipV: false, thumbnail: null, pw: 0, ph: 0, naturalPw: 0, naturalPh: 0, cropBox: null, textContent: null, filters: null };
    
    // 選択位置の後ろに挿入、選択されていなければ末尾
    let insertIdx = S.ws.length;
    if (S.sel.size > 0) {
      const selectedIds = [...S.sel];
      const lastSelectedId = selectedIds[selectedIds.length - 1];
      const foundIdx = S.ws.findIndex(w => w.id === lastSelectedId);
      if (foundIdx !== -1) insertIdx = foundIdx + 1;
    }
    
    S.ws.splice(insertIdx, 0, item);
    thumbQ(() => genThumb(item));
    
    saveState();
    renderAll();
  } catch (err) {
    console.error(err);
    alert('白紙の作成に失敗しました');
  } finally {
    hideProg();
  }
}

async function splitSelectedPages() {
  // 3D アイテムは分割対象外
  const selectedIds = [...S.sel].filter(id => {
    const it = S.ws.find(w => w.id === id);
    return it && it.type !== '3d';
  });
  if (!selectedIds.length) return;
  
  showProg(0, selectedIds.length, 'ページを分割中');
  
  try {
    for (let i = 0; i < selectedIds.length; i++) {
      const itemId = selectedIds[i];
      const itemIdx = S.ws.findIndex(w => w.id === itemId);
      if (itemIdx === -1) continue;
      
      const item = S.ws[itemIdx];
      const jsDoc = S.jsDocs.get(item.fileId);
      if (!jsDoc) continue;
      
      const page = await jsDoc.getPage(item.pageIndex + 1);
      const totalRot = (page.rotate + item.rotation) % 360;

      // ── プレビューと同じ状態でレンダリング (scanFixData・flipH/V を含む) ──
      let canvas, pdfBaseW, pdfBaseH;
      const SC = 2.0; // 劣化を防ぐ解像度倍率

      if (item.scanFixData) {
        // スキャン補正済み画像から生成
        const sfImg = new Image();
        sfImg.src = item.scanFixData.dataUrl;
        await new Promise(r => { sfImg.onload = r; });
        const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
        const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
        let bw, bh;
        if (item.rotation === 90 || item.rotation === 270) { bw = lh; bh = lw; }
        else { bw = lw; bh = lh; }
        pdfBaseW = bw;
        pdfBaseH = bh;
        canvas = document.createElement('canvas');
        // 分割時の丸め誤差やピクセル欠落を防ぐため偶数幅に補正
        canvas.width  = Math.round(bw * SC / 2) * 2;
        canvas.height = Math.round(bh * SC);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(item.rotation * Math.PI / 180);
        ctx.drawImage(sfImg, -lw * SC / 2, -lh * SC / 2, lw * SC, lh * SC);
        ctx.restore();
      } else {
        // 通常 PDF レンダリング
        const vp = page.getViewport({ scale: SC, rotation: totalRot });
        canvas = document.createElement('canvas');
        // 分割時の丸め誤差やピクセル欠落を防ぐため偶数幅に補正
        canvas.width  = Math.round(vp.width / 2) * 2;
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const origVp = page.getViewport({ scale: 1.0, rotation: totalRot });
        pdfBaseW = origVp.width;
        pdfBaseH = origVp.height;
      }

      // 現在のプレビュー状態（反転）を canvas に焼き込む
      applyFlipToCanvas(canvas, item);

      // 整数 halfW で L/R が重複・欠落しないよう切り出し
      const halfW     = Math.round(canvas.width / 2);
      const h         = canvas.height;
      const halfPdfW  = pdfBaseW / 2;
      const pdfH      = pdfBaseH;

      const canvasL = document.createElement('canvas');
      canvasL.width = halfW;
      canvasL.height = h;
      canvasL.getContext('2d').drawImage(canvas, 0, 0, halfW, h, 0, 0, halfW, h);

      const canvasR = document.createElement('canvas');
      canvasR.width = halfW;
      canvasR.height = h;
      canvasR.getContext('2d').drawImage(canvas, canvas.width - halfW, 0, halfW, h, 0, 0, halfW, h);

      const pdfDoc = await PDFDocument.create();
      
      const imgBytesL = await (await fetch(canvasL.toDataURL('image/jpeg', 0.95))).arrayBuffer();
      const imgL = await pdfDoc.embedJpg(imgBytesL);
      const pdfPageL = pdfDoc.addPage([halfPdfW, pdfH]);
      pdfPageL.drawImage(imgL, { x: 0, y: 0, width: halfPdfW, height: pdfH });

      const imgBytesR = await (await fetch(canvasR.toDataURL('image/jpeg', 0.95))).arrayBuffer();
      const imgR = await pdfDoc.embedJpg(imgBytesR);
      const pdfPageR = pdfDoc.addPage([halfPdfW, pdfH]);
      pdfPageR.drawImage(imgR, { x: 0, y: 0, width: halfPdfW, height: pdfH });
      
      const pdfBytes = await pdfDoc.save();
      const data = new Uint8Array(pdfBytes);
      
      const newJsDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
      const newFid = fid();
      const origF = S.files.get(item.fileId);
      const newColor = origF ? origF.color : '#3b82f6';
      const newName = origF ? origF.name.replace(/\.pdf$/i, '') + '_split.pdf' : 'split.pdf';
      
      S.files.set(newFid, { id: newFid, name: newName, data, pageCount: 2, color: newColor });
      S.jsDocs.set(newFid, newJsDoc);

      // ── サムネイルを canvasL/R から直接生成（renderAll時点で確実に正しい pw/ph/thumbnail を持たせる）
      const _pw = Math.round(halfPdfW);
      const _ph = Math.round(pdfH);
      const _dpr = Math.min(window.devicePixelRatio || 1, 2);
      const BASE_WIDTH = 595.28;
      const _scale = S.cardSize / BASE_WIDTH;
      const _cardW = Math.max(CARD_SIZE_MIN, Math.round(_pw * _scale));
      const _thumbW = Math.round(_cardW * _dpr);
      // アスペクト比の丸め誤差による「縦に伸びる」歪みを防ぐため、PDFの論理サイズの比率を正確に使用する
      const _thumbH = Math.round(_thumbW * pdfH / halfPdfW);
      const _makeThumb = (src) => {
        const tc = document.createElement('canvas');
        tc.width  = _thumbW;
        tc.height = _thumbH;
        tc.getContext('2d').drawImage(src, 0, 0, _thumbW, _thumbH);
        return tc.toDataURL('image/jpeg', 0.88);
      };

      const itemL = { id: uid(), fileId: newFid, pageIndex: 0, rotation: 0, flipH: false, flipV: false,
        thumbnail: _makeThumb(canvasL), pw: _pw, ph: _ph, naturalPw: _pw, naturalPh: _ph,
        cropBox: null, textContent: null, filters: null };
      const itemR = { id: uid(), fileId: newFid, pageIndex: 1, rotation: 0, flipH: false, flipV: false,
        thumbnail: _makeThumb(canvasR), pw: _pw, ph: _ph, naturalPw: _pw, naturalPh: _ph,
        cropBox: null, textContent: null, filters: null };
      
      // 分割されたページに置き換え
      S.ws.splice(itemIdx, 1, itemL, itemR);
      S.sel.delete(itemId);
      S.sel.add(itemL.id);
      S.sel.add(itemR.id);

      // genThumb はカードサイズ変更時の再生成のためにキューイングするが、
      // 初期表示は上記で生成済みのため表示乱れは起きない
      thumbQ(() => genThumb(itemL));
      thumbQ(() => genThumb(itemR));
      
      showProg(i + 1, selectedIds.length, 'ページを分割中');
    }
    
    saveState();
    renderAll();
    
  } catch (err) {
    console.error(err);
    alert('ページの分割に失敗しました。');
  } finally {
    hideProg();
  }
}

async function mergeSelectedPages(direction = 'h') {
  const selectedIds = [...S.sel].filter(id => {
    const it = S.ws.find(w => w.id === id);
    return it && it.type !== '3d';
  });
  
  if (selectedIds.length < 2) {
    alert('結合するには2つ以上のページを選択してください。');
    return;
  }
  
  // 並び順（S.ws）通りに結合する
  selectedIds.sort((a, b) => S.ws.findIndex(w => w.id === a) - S.ws.findIndex(w => w.id === b));
  showProg(0, selectedIds.length, 'ページを結合中');
  
  try {
    const renderDatas = [];
    let totalPdfW = 0, maxPdfH = 0;
    let maxPdfW = 0, totalPdfH = 0;
    let totalCanvasW = 0, maxCanvasH = 0;
    let maxCanvasW = 0, totalCanvasH = 0;
    
    const firstItemIdx = S.ws.findIndex(w => w.id === selectedIds[0]);
    const firstItem = S.ws[firstItemIdx];
    
    for (let i = 0; i < selectedIds.length; i++) {
      const itemId = selectedIds[i];
      const item = S.ws.find(w => w.id === itemId);
      const jsDoc = S.jsDocs.get(item.fileId);
      if (!jsDoc) continue;
      
      const page = await jsDoc.getPage(item.pageIndex + 1);
      const totalRot = (page.rotate + item.rotation) % 360;
      
      let canvas, pdfBaseW, pdfBaseH;
      const SC = 2.0; // 高解像度レンダリング
      
      if (item.scanFixData) {
        const sfImg = new Image();
        sfImg.src = item.scanFixData.dataUrl;
        await new Promise(r => { sfImg.onload = r; });
        const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
        const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
        let bw, bh;
        if (item.rotation === 90 || item.rotation === 270) { bw = lh; bh = lw; }
        else { bw = lw; bh = lh; }
        pdfBaseW = bw;
        pdfBaseH = bh;
        canvas = document.createElement('canvas');
        canvas.width  = Math.round(bw * SC);
        canvas.height = Math.round(bh * SC);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(item.rotation * Math.PI / 180);
        ctx.drawImage(sfImg, -lw * SC / 2, -lh * SC / 2, lw * SC, lh * SC);
        ctx.restore();
      } else {
        const vp = page.getViewport({ scale: SC, rotation: totalRot });
        canvas = document.createElement('canvas');
        canvas.width  = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const origVp = page.getViewport({ scale: 1.0, rotation: totalRot });
        pdfBaseW = origVp.width;
        pdfBaseH = origVp.height;
      }

      applyFlipToCanvas(canvas, item);

      renderDatas.push({ canvas, pdfBaseW, pdfBaseH });
      if (direction === 'h') {
        totalPdfW += pdfBaseW;
        maxPdfH = Math.max(maxPdfH, pdfBaseH);
        totalCanvasW += canvas.width;
        maxCanvasH = Math.max(maxCanvasH, canvas.height);
      } else {
        maxPdfW = Math.max(maxPdfW, pdfBaseW);
        totalPdfH += pdfBaseH;
        maxCanvasW = Math.max(maxCanvasW, canvas.width);
        totalCanvasH += canvas.height;
      }
      
      showProg(i + 1, selectedIds.length, 'ページを結合中');
    }
    
    if (renderDatas.length === 0) throw new Error('レンダリングに失敗しました');
    
    // グレースフル・デグラデーション：OOM回避のため超巨大キャンバスは自動縮小する
    const MAX_CANVAS_DIM = 8000;
    let mergeScale = 1.0;
    if (direction === 'h') {
      if (totalCanvasW > MAX_CANVAS_DIM || maxCanvasH > MAX_CANVAS_DIM) {
        mergeScale = Math.min(MAX_CANVAS_DIM / totalCanvasW, MAX_CANVAS_DIM / maxCanvasH);
      }
    } else {
      if (maxCanvasW > MAX_CANVAS_DIM || totalCanvasH > MAX_CANVAS_DIM) {
        mergeScale = Math.min(MAX_CANVAS_DIM / maxCanvasW, MAX_CANVAS_DIM / totalCanvasH);
      }
    }
    
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = Math.round((direction === 'h' ? totalCanvasW : maxCanvasW) * mergeScale);
    mergedCanvas.height = Math.round((direction === 'h' ? maxCanvasH : totalCanvasH) * mergeScale);
    const ctx = mergedCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, mergedCanvas.width, mergedCanvas.height);
    
    let currentX = 0, currentY = 0;
    for (const data of renderDatas) {
      const dw = Math.round(data.canvas.width * mergeScale);
      const dh = Math.round(data.canvas.height * mergeScale);
      if (direction === 'h') {
        ctx.drawImage(data.canvas, currentX, 0, dw, dh);
        currentX += dw;
      } else {
        ctx.drawImage(data.canvas, 0, currentY, dw, dh);
        currentY += dh;
      }
    }
    
    const pdfDoc = await PDFDocument.create();
    const imgBytes = await (await fetch(mergedCanvas.toDataURL('image/jpeg', 0.95))).arrayBuffer();
    const img = await pdfDoc.embedJpg(imgBytes);
    
    const finalPdfW = direction === 'h' ? totalPdfW : maxPdfW;
    const finalPdfH = direction === 'h' ? maxPdfH : totalPdfH;
    const pdfPage = pdfDoc.addPage([finalPdfW, finalPdfH]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: finalPdfW, height: finalPdfH });
    
    const pdfBytes = await pdfDoc.save();
    const data = new Uint8Array(pdfBytes);
    
    const newJsDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    const newFid = fid();
    const origF = S.files.get(firstItem.fileId);
    const newColor = origF ? origF.color : '#3b82f6';
    const newName = origF ? origF.name.replace(/\.pdf$/i, '') + '_merged.pdf' : 'merged.pdf';
    
    S.files.set(newFid, { id: newFid, name: newName, data, pageCount: 1, color: newColor });
    S.jsDocs.set(newFid, newJsDoc);

    const _pw = Math.round(finalPdfW);
    const _ph = Math.round(finalPdfH);
    const _dpr = Math.min(window.devicePixelRatio || 1, 2);
    const BASE_WIDTH = 595.28;
    const _scale = S.cardSize / BASE_WIDTH;
    const _cardW = Math.max(CARD_SIZE_MIN, Math.round(_pw * _scale));
    const _thumbW = Math.round(_cardW * _dpr);
    const _thumbH = Math.round(_thumbW * finalPdfH / finalPdfW);
    
    const tc = document.createElement('canvas');
    tc.width = _thumbW;
    tc.height = _thumbH;
    tc.getContext('2d').drawImage(mergedCanvas, 0, 0, _thumbW, _thumbH);

    const newItem = {
      id: uid(), fileId: newFid, pageIndex: 0, rotation: 0, flipH: false, flipV: false,
      thumbnail: tc.toDataURL('image/jpeg', 0.88), pw: _pw, ph: _ph, naturalPw: _pw, naturalPh: _ph,
      cropBox: null, textContent: null, filters: null
    };
    
    S.ws = S.ws.filter(w => !selectedIds.includes(w.id));
    const insertPos = Math.min(firstItemIdx, S.ws.length);
    S.ws.splice(insertPos, 0, newItem);
    
    S.sel.clear();
    S.sel.add(newItem.id);
    
    thumbQ(() => genThumb(newItem));
    
    saveState();
    renderAll();
    
  } catch (err) {
    console.error(err);
    alert('ページの結合に失敗しました。');
  } finally {
    hideProg();
  }
}

function rotatePage(itemId, delta, save = true) {
  const item = S.ws.find(w => w.id === itemId);
  if (!item || item.type === '3d') return;  // 3D アイテムは回転不可
  item.rotation = ((item.rotation + delta) + 360) % 360;

  const wrap = document.querySelector(`[data-id="${itemId}"]`);
  if (wrap) {
    // リスト表示の回転テキスト更新
    const rotEl = wrap.querySelector('.pr-rot');
    if (rotEl) rotEl.textContent = item.rotation ? `${item.rotation}°` : '−';

    // pc-area内を再構築（バッジ＋ローディング）+ 即時アスペクト比反映
    const area = wrap.querySelector('.pc-area');
    if (area) {
      const rotCls = item.rotation !== 0 ? 'pc-rot-badge visible' : 'pc-rot-badge';
      area.innerHTML = `<div class="${rotCls}"><i class="fa-solid fa-rotate"></i> ${item.rotation}°</div><div class="ld"><i class="fa-solid fa-spinner"></i><span>読込中</span></div>`;
      // naturalPw/Ph + pageRotate から回転後の寸法を即時算出
      // （genThumb完了を待たずカード幅・アスペクト比を更新）
      if (item.naturalPw && item.naturalPh) {
        const totalRot = ((item.pageRotate || 0) + item.rotation) % 360;
        const swap = totalRot === 90 || totalRot === 270;
        item.pw = swap ? item.naturalPh : item.naturalPw;
        item.ph = swap ? item.naturalPw : item.naturalPh;
        applyRot(area, item);
        scheduleMasonry();  // カード幅を即時更新（横長なら横長カードに）
      }
    }
  }

  item.thumbnail = null;
  thumbQ(() => genThumb(item));
  // genThumb完了後 → patchThumbDOM → applyRot でpw/phが回転後の実寸に更新

  if (Viewer.isOpen && Viewer.currentId === itemId) Viewer.rerender();

  if (save) saveState();
}

function rotateSel(delta) { S.sel.forEach(id => rotatePage(id, delta, false)); saveState(); }

// ── 反転処理 ─────────────────────────────────────────────────────
function applyFlipToCanvas(canvas, item) {
  if (!item || (!item.flipH && !item.flipV)) return;
  const off = document.createElement('canvas');
  off.width  = canvas.width;
  off.height = canvas.height;
  const ctx = off.getContext('2d');
  ctx.save();
  ctx.translate(item.flipH ? canvas.width : 0, item.flipV ? canvas.height : 0);
  ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  canvas.getContext('2d').drawImage(off, 0, 0);
}

function flipPage(itemId, axis, save = true) {
  const item = S.ws.find(w => w.id === itemId);
  if (!item) return;
  if (axis === 'h') item.flipH = !item.flipH;
  else               item.flipV = !item.flipV;
  item.thumbnail = null;
  thumbQ(() => genThumb(item));
  if (save) saveState();
}

function flipSel(axis) { S.sel.forEach(id => flipPage(id, axis, false)); saveState(); }

// ── 編集状態の確定（ラスタライズ）処理 ─────────────────────────────────
async function commitItemEdits(item) {
  const jsDoc = S.jsDocs.get(item.fileId);
  if (!jsDoc && !item.scanFixData) return;

  const SC = 2.0;
  let canvas, baseW, baseH;

  try {
    if (item.scanFixData) {
      const sfImg = new Image();
      sfImg.src = item.scanFixData.dataUrl;
      await new Promise(r => { sfImg.onload = r; });
      const lw = item.scanFixData.logicalWidth ?? item.scanFixData.width / 2;
      const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
      let bw, bh;
      if (item.rotation === 90 || item.rotation === 270) { bw = lh; bh = lw; }
      else { bw = lw; bh = lh; }
      baseW = bw; baseH = bh;
      canvas = document.createElement('canvas');
      canvas.width = Math.round(bw * SC);
      canvas.height = Math.round(bh * SC);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(item.rotation * Math.PI / 180);
      ctx.drawImage(sfImg, -lw * SC / 2, -lh * SC / 2, lw * SC, lh * SC);
      ctx.restore();
    } else {
      const page = await jsDoc.getPage(item.pageIndex + 1);
      const totalRot = (page.rotate + item.rotation) % 360;
      const vp = page.getViewport({ scale: SC, rotation: totalRot });
      baseW = vp.width / SC;
      baseH = vp.height / SC;
      canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }

    const fStr = getFilterString(item.filters);
    if (fStr !== 'none') {
      const fCnv = document.createElement('canvas');
      fCnv.width = canvas.width; fCnv.height = canvas.height;
      const fCtx = fCnv.getContext('2d');
      fCtx.filter = fStr;
      fCtx.drawImage(canvas, 0, 0);
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      canvas.getContext('2d').drawImage(fCnv, 0, 0);
    }

    applyFlipToCanvas(canvas, item);

    if (item.paintData) {
      const pImg = new Image();
      pImg.src = item.paintData.dataUrl;
      await new Promise(r => { pImg.onload = r; });
      canvas.getContext('2d').drawImage(pImg, 0, 0, canvas.width, canvas.height);
    }

    let finalCanvas = canvas;
    let finalLogW = baseW;
    let finalLogH = baseH;

    if (item.cropBox) {
      const { x, y, width, height } = item.cropBox;
      const cw = canvas.width, ch = canvas.height;
      const cx = cw * x, cy = ch * y, cw2 = cw * width, ch2 = ch * height;
      finalCanvas = document.createElement('canvas');
      finalCanvas.width = Math.max(1, cw2);
      finalCanvas.height = Math.max(1, ch2);
      finalCanvas.getContext('2d').drawImage(canvas, cx, cy, cw2, ch2, 0, 0, cw2, ch2);
      finalLogW = baseW * width;
      finalLogH = baseH * height;
    }

    item.scanFixData = {
      dataUrl: finalCanvas.toDataURL('image/jpeg', 0.95),
      width: finalCanvas.width,
      height: finalCanvas.height,
      logicalWidth: finalLogW,
      logicalHeight: finalLogH
    };

    item.rotation = 0;
    item.pageRotate = 0;
    item.flipH = false;
    item.flipV = false;
    item.cropBox = null;
    item.paintData = null;
    item.filters = null;
    item.pw = finalLogW;
    item.ph = finalLogH;
    item.naturalPw = finalLogW;
    item.naturalPh = finalLogH;
    item.thumbnail = null;

  } catch (err) {
    console.error("commitItemEdits failed:", err);
  }
}

function delPage(itemId) {
  S.ws = S.ws.filter(w => w.id !== itemId);
  S.sel.delete(itemId);
  document.querySelector(`[data-id="${itemId}"]`)?.remove();
  reindex();
  saveState();
  syncUI();
  scheduleMasonry();
  renderSidebar();
}

function delSel() {
  [...S.sel].forEach(id => {
    S.ws = S.ws.filter(w => w.id !== id);
    document.querySelector(`[data-id="${id}"]`)?.remove();
  });
  S.sel.clear();
  reindex();
  saveState();
  syncUI();
  scheduleMasonry();
  renderSidebar();
}

function duplicateSel() {
  if (S.sel.size === 0) return;
  const newItems = [];
  const itemsToClone = S.ws.filter(w => S.sel.has(w.id));
  
  itemsToClone.forEach(orig => {
    const clone = { ...orig, id: uid(), thumbnail: null };
    const idx = S.ws.indexOf(orig);
    S.ws.splice(idx + 1, 0, clone);
    newItems.push(clone);
    thumbQ(() => genThumb(clone));
  });
  
  S.sel.clear();
  newItems.forEach(item => S.sel.add(item.id));
  reindex();
  saveState();
  renderAll();
}

function alignSelectedPages(targetOrientation) {
  const itemsToAlign = S.sel.size > 0 ? S.ws.filter(w => S.sel.has(w.id)) : S.ws;
  if (itemsToAlign.length === 0) return;
  
  let changed = false;
  itemsToAlign.forEach(item => {
    if (item.type === '3d') return;
    const totalRot = (item.pageRotate || 0) + item.rotation;
    const isSwapped = totalRot % 180 !== 0;
    // オリジナルの寸法から現在の表示上の縦横を計算
    const currentW = isSwapped ? item.naturalPh : item.naturalPw;
    const currentH = isSwapped ? item.naturalPw : item.naturalPh;
    
    // 未レンダリングで寸法不明時はスキップ
    if (!currentW || !currentH) return;
    
    const isPortrait = currentW <= currentH;
    
    if (targetOrientation === 'v' && !isPortrait) {
      rotatePage(item.id, 90, false);
      changed = true;
    } else if (targetOrientation === 'h' && isPortrait) {
      rotatePage(item.id, 90, false);
      changed = true;
    }
  });
  
  if (changed) {
    saveState();
  }
}

function clearAll() {
  if (S.ws.length === 0) return;
  if (!confirm('読み込んだすべてのファイルとページを削除します。\nよろしいですか？')) return;
  
  S.files.clear();
  S.jsDocs.clear();
  S.ws = [];
  S.sel.clear();
  S.history = [];
  S.histIdx = -1;
  DB.clearAll().catch(console.error);
  
  renderAll();
  updateStat();
}

function reindex() {
  document.querySelectorAll('[data-id]').forEach((el, i) => {
    const n = el.querySelector('.pc-num, .pr-num');
    if (n) n.textContent = i + 1;
  });
  checkEmpty();
  updateStat();
}

function editMemo(itemId) {
  const item = S.ws.find(w => w.id === itemId);
  if (!item) return;
  const overlay = g('memo-overlay');
  const ta = g('memo-text');
  
  ta.value = item.memo || '';
  overlay.classList.remove('hidden');
  ta.focus();
  
  const closeMemo = () => overlay.classList.add('hidden');
  
  g('memo-close').onclick = closeMemo;
  g('memo-cancel').onclick = closeMemo;
  
  g('memo-clear').onclick = () => {
    ta.value = '';
    ta.focus();
  };
  
  g('memo-save').onclick = () => {
    const val = ta.value.trim();
    item.memo = val ? val : null;
    saveState();
    renderAll();
    closeMemo();
  };
}

// ============================================================
// SEARCH (Filter)
// ============================================================
let _searchTimer = null;
let _searchStrict = false;

function normalizeText(text) {
  if (!text) return '';
  return text.normalize('NFKC').toLowerCase();
}

function filterSearch(query) {
  const pc = g('page-container');
  const hitEl = g('search-hits');
  if (!query) {
    pc.querySelectorAll('.pc, .pr').forEach(el => el.style.display = '');
    if (hitEl) hitEl.classList.add('hidden');
    scheduleMasonry();
    return;
  }
  
  const q = _searchStrict ? query : normalizeText(query);
  let hits = 0;
  
  S.ws.forEach(async w => {
    const el = document.querySelector(`[data-id="${w.id}"]`);
    if (!el) return;

    // 3D アイテムはテキスト検索対象外として常に表示
    if (w.type === '3d') {
      el.style.display = '';
      hits++;
      updateHits();
      return;
    }

    let text = w.textContent;
    if (text === undefined || text === null) {
       const jsDoc = S.jsDocs.get(w.fileId);
       if (jsDoc) {
          try {
            const page = await jsDoc.getPage(w.pageIndex + 1);
            text = await extractPageText(page);
            w.textContent = text;
          } catch(e) { text = ''; }
       }
    }
    const t = _searchStrict ? (text || '') : normalizeText(text || '');
    if (t.includes(q)) {
       el.style.display = '';
       hits++;
    } else {
       el.style.display = 'none';
    }
    updateHits();
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(scheduleMasonry, 50);
  });

  function updateHits() {
    if (hitEl) {
      hitEl.textContent = `${hits}件`;
      hitEl.classList.remove('hidden');
    }
  }
}

// ============================================================
// SELECTION
// ============================================================
function selPage(itemId, e) {
  if (e.ctrlKey || e.metaKey) {
    S.sel.has(itemId) ? S.sel.delete(itemId) : S.sel.add(itemId);
  } else if (e.shiftKey && S.sel.size > 0) {
    const ids = S.ws.map(w => w.id);
    const ci  = ids.indexOf(itemId);
    const li  = ids.indexOf([...S.sel].at(-1) ?? itemId);
    const [a, b] = [Math.min(ci, li), Math.max(ci, li)];
    ids.slice(a, b + 1).forEach(id => S.sel.add(id));
  } else {
    S.sel.clear();
    S.sel.add(itemId);
  }
  syncSelDOM();
  syncUI();
}

function selAll()  { S.ws.forEach(w => S.sel.add(w.id)); syncSelDOM(); syncUI(); }
function deselAll(){ S.sel.clear(); syncSelDOM(); syncUI(); }
function invSel()  {
  S.ws.forEach(w => S.sel.has(w.id) ? S.sel.delete(w.id) : S.sel.add(w.id));
  syncSelDOM(); syncUI();
}
function selFile(fileId) {
  S.ws.filter(w => w.fileId === fileId).forEach(w => S.sel.add(w.id));
  syncSelDOM(); syncUI();
}

function syncSelDOM() {
  const selArr = [...S.sel];
  document.querySelectorAll('[data-id]').forEach(el => {
    const id = el.dataset.id;
    const isSel = S.sel.has(id);
    el.classList.toggle('sel', isSel);
    const badge = el.querySelector('.pc-sel-badge, .pr-sel-badge');
    if (badge) {
      badge.textContent = isSel ? selArr.indexOf(id) + 1 : '';
    }
  });
  updateStat();
}

// ============================================================
// EXPORT (PDF-lib) & MASKING
// ============================================================

async function applyMaskingToPage(jsDoc, pdfPage, itemObj, maskPatterns) {
  try {
    const page = await jsDoc.getPage(itemObj.pageIndex + 1);
    const tc = await page.getTextContent();

    for (const item of tc.items) {
      if (!item.str) continue;
      
      let match;
      for (const regex of maskPatterns) {
        const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
        const re = new RegExp(regex.source, flags);
        
        while ((match = re.exec(item.str)) !== null) {
          const fullLen = item.str.length;
          const matchLen = match[0].length;
          
          const [scX, skY, skX, scY, tx, ty] = item.transform;
          const fontHeight = scY; 
          const itemWidth = item.width;
          
          const ratioStart = match.index / fullLen;
          const ratioWidth = matchLen / fullLen;
          
          let rectX = tx + (itemWidth * ratioStart);
          let rectY = ty - (fontHeight * 0.15); // ベースラインから少し下げる
          let rectW = itemWidth * ratioWidth;
          let rectH = fontHeight * 1.1;

          pdfPage.drawRectangle({
            x: rectX,
            y: rectY,
            width: rectW,
            height: rectH,
            color: PDFLib.rgb(0.1, 0.1, 0.1) // 黒塗り
          });
        }
      }
    }
  } catch (err) {
    console.error("Masking error:", err);
  }
}

async function drawTextOnPage(pdfPage, text, font, drawMode, baseW, baseH, pdfDoc) {
  if (!text || !font) return pdfPage;
  
  let currentPage = pdfPage;
  const fontSize = 11;
  const lineHeight = fontSize * 1.5;
  const margin = 30;
  const maxWidth = baseW - margin * 2;
  
  const lines = text.split('\n');
  const wrappedLines = [];
  
  for (const line of lines) {
    let currentLine = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const testLine = currentLine + char;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);
      if (testWidth > maxWidth && i > 0) {
        wrappedLines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    wrappedLines.push(currentLine);
  }

  // overlayモードの場合は背景に半透明の白幕を引く
  if (drawMode === 'overlay') {
    currentPage.drawRectangle({
      x: 0, y: 0, width: baseW, height: baseH,
      color: PDFLib.rgb(1, 1, 1),
      opacity: 0.85
    });
  }
  
  let cursorY = baseH - margin - fontSize;
  const isTransparent = drawMode === 'transparent';
  const drawColor = isTransparent ? PDFLib.rgb(1,1,1) : PDFLib.rgb(0.1,0.1,0.1);
  // 完全な0ではなく極微量の不透明度を残すことで、大半のPDFビューワーでテキストとして認識・検索・選択できるようにする
  const drawOpacity = isTransparent ? 0.01 : 1;
  
  for (const line of wrappedLines) {
    if (cursorY < margin) {
      if (isTransparent || drawMode === 'overlay') {
        cursorY = margin;
      } else {
        currentPage = pdfDoc.addPage([baseW, baseH]);
        cursorY = baseH - margin - fontSize;
      }
    }
    
    currentPage.drawText(line, {
      x: margin,
      y: cursorY,
      size: fontSize,
      font: font,
      color: drawColor,
      opacity: drawOpacity
    });
    cursorY -= lineHeight;
  }
  return currentPage;
}

async function exportItems(items, name, mode = 'download') {
  // 3Dアイテムは PDF エクスポートの対象外
  items = items.filter(w => w.type !== '3d');
  if (!items.length) return;
  try {
    showProg(0, items.length, 'エクスポート準備中');
    const newDoc = await PDFDocument.create();

    const mTitle = g('meta-title')?.value.trim();
    const mAuthor = g('meta-author')?.value.trim();
    const mKeywords = g('meta-keywords')?.value.trim();
    if (mTitle) newDoc.setTitle(mTitle);
    if (mAuthor) newDoc.setAuthor(mAuthor);
    if (mKeywords) newDoc.setKeywords(mKeywords.split(',').map(k => k.trim()));

    const isEncrypted = g('meta-encrypt')?.checked;
    const pw = g('meta-pw')?.value;
    if (isEncrypted && pw) {
      alert("【お知らせ】現在使用しているライブラリ (pdf-lib) は、パスワード保護付きの保存に対応していません。エクスポートは続行されますがパスワードは付与されません。");
    }

    const isPageno = g('meta-pageno')?.checked;
    const pagenoPos = g('pageno-pos')?.value || 'bottom-center';
    const pagenoFmt = g('pageno-fmt')?.value || '1';
    const pagenoStart = parseInt(g('pageno-start')?.value || '1', 10);
    let helveticaFont;
    if (isPageno) {
      helveticaFont = await newDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    }

    const isIncludeText = g('meta-include-text')?.checked;
    const textReflectMode = g('text-reflect-mode')?.value || 'transparent';
    let customFont = null;

    if (isIncludeText) {
      try {
        showProg(0, items.length, '日本語フォントを読み込み中...');
        if (window.fontkit) newDoc.registerFontkit(window.fontkit);
        
        let fontBytes = null;
        // 確実性の高いCDNから日本語フォント（Noto Sans JP）を取得するフォールバックリスト
        const fontUrls = [
          'https://cdn.jsdelivr.net/npm/noto-sans-japanese@1.0.0/fonts/NotoSansJP-Regular.otf',
          'https://unpkg.com/noto-sans-japanese@1.0.0/fonts/NotoSansJP-Regular.otf'
        ];
        
        for (const url of fontUrls) {
          try {
            const fontRes = await fetch(url);
            if (fontRes.ok) {
              fontBytes = await fontRes.arrayBuffer();
              break;
            }
          } catch (e) {
            console.warn('Font fetch failed from: ' + url, e);
          }
        }
        
        if (!fontBytes) throw new Error('フォントデータの取得に失敗しました');
        
        customFont = await newDoc.embedFont(fontBytes);
      } catch (e) {
        console.error('Font load error:', e);
        alert('日本語フォントの読み込みに失敗したため、テキストの反映はスキップされます。\nインターネット接続を確認してください。');
        customFont = null;
      }
    }

    const isCompress = g('meta-compress')?.checked;
    const isGrayscale = g('meta-grayscale')?.checked;
    const compQuality = parseFloat(g('compress-slider')?.value || "0.6");

    const isIncludePaint = g('meta-include-paint')?.checked;
    const isMasking = g('meta-masking')?.checked;
    const maskPatterns = [];
    if (isMasking) {
      if (g('mask-phone')?.checked) maskPatterns.push(/\b0\d{1,4}[-(]?\d{1,4}[-)]?\d{3,4}\b/);
      if (g('mask-mynum')?.checked) maskPatterns.push(/\b\d{12}\b/);
      if (g('mask-email')?.checked) maskPatterns.push(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
      const customKws = g('mask-custom')?.value.split(',').map(s => s.trim()).filter(Boolean);
      if (customKws && customKws.length > 0) {
        const escaped = customKws.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        maskPatterns.push(new RegExp(escaped, 'i'));
      }
    }

    let needsRasterizeGlobal = isCompress || isGrayscale;
    if (isIncludeText && (textReflectMode === 'transparent' || textReflectMode === 'overlay')) {
      needsRasterizeGlobal = true; // 透明またはオーバーレイ描画の場合は元のテキスト層を消すため強制ラスタライズ
    }

    const getPageSize = (sizeStr) => {
      switch(sizeStr) {
        case 'A3': return [841.89, 1190.55];
        case 'B4': return [708.66, 1000.63];
        case 'B5': return [498.90, 708.66];
        case 'Letter': return [612.00, 792.00];
        case 'A4':
        default: return [595.28, 841.89];
      }
    };

    if (needsRasterizeGlobal || items.some(it => (it.filters && getFilterString(it.filters) !== 'none') || it.scanFixData || it.flipH || it.flipV)) {
      for (let i = 0; i < items.length; i++) {
        showProg(i + 1, items.length, '画像化処理中');
        const item = items[i];
        const jsDoc = S.jsDocs.get(item.fileId);
        if (!jsDoc) continue;

        const page = await jsDoc.getPage(item.pageIndex + 1);
        const totalRot = (page.rotate + item.rotation) % 360;
        
        let baseW, baseH;
        if (item.scanFixData) {
          const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
          const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
          if (item.rotation === 90 || item.rotation === 270) {
            baseW = lh;
            baseH = lw;
          } else {
            baseW = lw;
            baseH = lh;
          }
        } else {
          const vp0 = page.getViewport({ scale: 1, rotation: totalRot });
          baseW = vp0.width;
          baseH = vp0.height;
        }

        const isReplaceMode = isIncludeText && textReflectMode === 'replace';
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(baseW * 1.5);
        canvas.height = Math.round(baseH * 1.5);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        if (!isReplaceMode) {
          if (item.scanFixData) {
            const img = new Image();
            img.src = item.scanFixData.dataUrl;
            await new Promise(r => { img.onload = r; });
            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(item.rotation * Math.PI / 180);
            const _elw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
            const _elh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
            ctx.drawImage(img, -_elw * 1.5 / 2, -_elh * 1.5 / 2, _elw * 1.5, _elh * 1.5);
            ctx.restore();
          } else {
            const vp = page.getViewport({ scale: 1.5, rotation: totalRot });
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          }

          const fStr = getFilterString(item.filters);
          let finalFilter = 'none';
          if (isGrayscale && fStr !== 'none') finalFilter = `grayscale(100%) ${fStr}`;
          else if (isGrayscale) finalFilter = 'grayscale(100%)';
          else if (fStr !== 'none') finalFilter = fStr;

          if (finalFilter !== 'none') {
            const fCnv = document.createElement('canvas');
            fCnv.width = canvas.width; fCnv.height = canvas.height;
            const fCtx = fCnv.getContext('2d');
            fCtx.filter = finalFilter;
            fCtx.drawImage(canvas, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(fCnv, 0, 0);
          }

          // 反転適用（paint合成前に行う）
          applyFlipToCanvas(canvas, item);

          if (isIncludePaint && item.paintData) {
            const img = new Image();
            img.src = item.paintData.dataUrl;
            await new Promise(r => { img.onload = r; });
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }

          if (isMasking && maskPatterns.length > 0) {
            try {
              const tc = await page.getTextContent();
              const vp = page.getViewport({ scale: 1.5, rotation: totalRot });
              for (const tItem of tc.items) {
                if (!tItem.str) continue;
                let match;
                for (const regex of maskPatterns) {
                  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
                  const re = new RegExp(regex.source, flags);
                  while ((match = re.exec(tItem.str)) !== null) {
                    const fullLen = tItem.str.length;
                    const matchLen = match[0].length;
                    const [scX, skY, skX, scY, tx, ty] = tItem.transform;
                    
                    const pt = vp.convertToViewportPoint(tx, ty);
                    const fontH = scY * vp.scale;
                    const itemW = tItem.width * vp.scale;
                    
                    const ratioStart = match.index / fullLen;
                    const ratioWidth = matchLen / fullLen;
                    
                    const rectX = pt[0] + (itemW * ratioStart);
                    const rectY = pt[1] - fontH; 
                    const rectW = itemW * ratioWidth;
                    const rectH = fontH * 1.2;
                    
                    ctx.fillStyle = '#222222';
                    ctx.fillRect(rectX, rectY, rectW, rectH);
                  }
                }
              }
            } catch(e) { console.error(e); }
          }
        }

        const isUniformA4 = g('meta-uniform-a4')?.checked;
        const uniformSize = g('uniform-size-sel')?.value || 'A4';

        let pdfPage;

        if (!isReplaceMode) {
          const quality = isCompress ? compQuality : 0.95;
          const imgDataUrl = canvas.toDataURL('image/jpeg', quality);
          const imgBytes = await fetch(imgDataUrl).then(res => res.arrayBuffer());
          const pdfImage = await newDoc.embedJpg(imgBytes);

          if (isUniformA4) {
            const tgtSize = getPageSize(uniformSize);
            const isLand = baseW > baseH;
            pdfPage = newDoc.addPage(isLand ? [tgtSize[1], tgtSize[0]] : [tgtSize[0], tgtSize[1]]);
            const scale = Math.min(pdfPage.getWidth() / baseW, pdfPage.getHeight() / baseH);
            pdfPage.drawImage(pdfImage, {
              x: (pdfPage.getWidth() - baseW * scale) / 2,
              y: (pdfPage.getHeight() - baseH * scale) / 2,
              width: baseW * scale,
              height: baseH * scale,
            });
          } else {
            pdfPage = newDoc.addPage([baseW, baseH]);
            pdfPage.drawImage(pdfImage, { x: 0, y: 0, width: baseW, height: baseH });
          }
        } else {
          // Replaceモードかつ全体画像化指定がされている場合は、軽量な白紙で対応
          if (isUniformA4) {
            const tgtSize = getPageSize(uniformSize);
            const isLand = baseW > baseH;
            pdfPage = newDoc.addPage(isLand ? [tgtSize[1], tgtSize[0]] : [tgtSize[0], tgtSize[1]]);
          } else {
            pdfPage = newDoc.addPage([baseW, baseH]);
          }
        }

        // 編集テキストの描画（透過または白紙上書きまたはオーバーレイ）
        if (isIncludeText && customFont && item.textContent) {
          pdfPage = await drawTextOnPage(pdfPage, item.textContent, customFont, textReflectMode, pdfPage.getWidth(), pdfPage.getHeight(), newDoc);
        }
      }
    } else {
      const isUniformA4 = g('meta-uniform-a4')?.checked;
      const uniformSize = g('uniform-size-sel')?.value || 'A4';

      const groups = new Map();
      items.forEach((item, i) => {
        if (!groups.has(item.fileId)) groups.set(item.fileId, []);
        groups.get(item.fileId).push({ item, i });
      });

      const slots = new Array(items.length);
      let done = 0;

      for (const [fid, group] of groups) {
        const f = S.files.get(fid);
        if (!f) continue;
        const srcDoc = await PDFDocument.load(f.data.slice(0), {
          password: f.password,
          ignoreEncryption: true
        });
        const idxs   = group.map(g => g.item.pageIndex);
        const copied = await newDoc.copyPages(srcDoc, idxs);
        group.forEach((g, k) => {
          slots[g.i] = { page: copied[k], item: g.item };
          showProg(++done, items.length, 'エクスポート中');
        });
      }

      for (let i = 0; i < slots.length; i++) {
        let { page, item } = slots[i];
        let rot = item.rotation || 0;
        const isReplaceMode = isIncludeText && textReflectMode === 'replace';
        const tgtSize = getPageSize(uniformSize);
        
        if (isReplaceMode) {
          // 元のページは破棄して白紙ベースでテキストだけを描画する
          let baseW = item.pw || 595.28;
          let baseH = item.ph || 841.89;
          if (isUniformA4) {
            const isLand = baseW > baseH;
            page = newDoc.addPage(isLand ? [tgtSize[1], tgtSize[0]] : [tgtSize[0], tgtSize[1]]);
          } else {
            page = newDoc.addPage([baseW, baseH]);
          }
          if (item.textContent) {
            page = await drawTextOnPage(page, item.textContent, customFont, 'replace', page.getWidth(), page.getHeight(), newDoc);
          }
        } else {
          if (item.cropBox) {
              const { x, y, width, height } = item.cropBox;
              const pb = page.getCropBox() || page.getMediaBox();
              page.setCropBox(
                 pb.x + pb.width * x,
                 pb.y + pb.height * (1 - y - height),
                 pb.width * width,
                 pb.height * height
              );
          }

          if (isUniformA4) {
              if (rot) page.setRotation(degrees((page.getRotation().angle + rot) % 360));
              const embeddedPage = await newDoc.embedPage(page);
              const isLand = embeddedPage.width > embeddedPage.height;
              const a4Page = newDoc.addPage(isLand ? [tgtSize[1], tgtSize[0]] : [tgtSize[0], tgtSize[1]]);
              const scale = Math.min(a4Page.getWidth() / embeddedPage.width, a4Page.getHeight() / embeddedPage.height);
              a4Page.drawPage(embeddedPage, {
                  x: (a4Page.getWidth() - embeddedPage.width * scale) / 2,
                  y: (a4Page.getHeight() - embeddedPage.height * scale) / 2,
                  width: embeddedPage.width * scale,
                  height: embeddedPage.height * scale,
              });
              page = a4Page; 
          } else {
              if (rot) page.setRotation(degrees((page.getRotation().angle + rot) % 360));
              newDoc.addPage(page);
          }
          
          if (!isUniformA4 && isMasking && maskPatterns.length > 0) {
            const jsDoc = S.jsDocs.get(items[i].fileId);
            if (jsDoc) await applyMaskingToPage(jsDoc, page, items[i], maskPatterns);
          }

          if (isIncludePaint && item.paintData) {
            const pngBytes = await fetch(item.paintData.dataUrl).then(res => res.arrayBuffer());
            const pngImage = await newDoc.embedPng(pngBytes);
            const { width: pw, height: ph } = page.getSize();
            page.drawImage(pngImage, { x: 0, y: 0, width: pw, height: ph });
          }
        }
      }
    }

    if (isPageno && helveticaFont) {
      const pages = newDoc.getPages();
      const total = pages.length;
      for (let i = 0; i < total; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const currentNum = pagenoStart + i;
        let text = `${currentNum}`;
        if (pagenoFmt === '- 1 -') text = `- ${currentNum} -`;
        if (pagenoFmt === '1 / N') text = `${currentNum} / ${total}`;
        
        const textSize = 11;
        const textWidth = helveticaFont.widthOfTextAtSize(text, textSize);
        
        let tx = width / 2 - textWidth / 2;
        let ty = 20;
        
        if (pagenoPos === 'bottom-right') { tx = width - textWidth - 20; }
        if (pagenoPos === 'top-center') { ty = height - 30; }
        if (pagenoPos === 'top-right') { tx = width - textWidth - 20; ty = height - 30; }
        
        page.drawText(text, {
          x: tx, y: ty, size: textSize, font: helveticaFont, color: PDFLib.rgb(0.2, 0.2, 0.2)
        });
      }
    }

    showProg(items.length, items.length, 'ファイル構築中');
    const bytes = await newDoc.save();

    if (mode === 'print') {
      showProg(items.length, items.length, '印刷準備中');
      await printPdfBytes(bytes);
    } else {
      const a = document.createElement('a');
      a.href     = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  } catch (err) {
    console.error(err);
    if (mode === 'print') {
      showPrintError('印刷用のPDFを作成できませんでした。\n\n' + (err.message || err));
    } else {
      alert('エクスポートエラー: ' + err.message);
    }
  } finally {
    hideProg();
  }
}

// 印刷エラー用モーダルを表示する
function showPrintError(message) {
  const overlay = g('print-error-overlay');
  if (!overlay) { alert('印刷エラー: ' + message); return; }

  g('print-error-msg').textContent = message;
  overlay.classList.remove('hidden');

  const close = () => overlay.classList.add('hidden');
  g('print-error-close').onclick = close;
  g('print-error-ok').onclick = close;
}

// 生成したPDFバイト列を隠しiframeに読み込み、ブラウザの印刷ダイアログを開く
function printPdfBytes(bytes) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';
    iframe.style.opacity = '0';

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocusAfterPrint);
      setTimeout(() => {
        if (iframe.parentNode) document.body.removeChild(iframe);
        URL.revokeObjectURL(url);
      }, 1000);
      resolve();
    };
    // 印刷ダイアログを閉じるとウィンドウにフォーカスが戻ることを利用してクリーンアップする
    const onFocusAfterPrint = () => cleanup();

    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        window.addEventListener('focus', onFocusAfterPrint);
      } catch (e) {
        console.error('印刷起動エラー:', e);
        window.open(url, '_blank');
        cleanup();
        return;
      }
      // フォーカスイベントが発火しない環境向けのフォールバック
      setTimeout(cleanup, 60000);
    };

    document.body.appendChild(iframe);
    iframe.src = url;
  });
}

function getExportName(items, isAll) {
  return new Promise((resolve) => {
    let defaultName = 'merged.pdf';
    if (items.length > 0) {
      const fileNames = [...new Set(items.map(w => {
        const f = S.files.get(w.fileId);
        return f ? f.name.replace(/\.pdf$/i, '') : null;
      }).filter(Boolean))];

      if (fileNames.length === 1) {
        defaultName = fileNames[0] + (isAll ? '_ALL.pdf' : '_selected.pdf');
      } else if (fileNames.length > 1) {
        let prefix = fileNames[0];
        for (let i = 1; i < fileNames.length; i++) {
          while (fileNames[i].indexOf(prefix) !== 0) {
            prefix = prefix.substring(0, prefix.length - 1);
            if (!prefix) break;
          }
        }
        if (prefix.length >= 2) {
          prefix = prefix.replace(/[_\-\s]+$/, '');
          defaultName = prefix + (isAll ? '_ALL.pdf' : '_selected.pdf');
        } else {
          defaultName = fileNames[0] + '_etc' + (isAll ? '_ALL.pdf' : '_selected.pdf');
        }
      }
    }

    const modal = g('export-overlay');
    const input = g('export-filename');
    const suggBox = g('export-suggestions');
    const btnCancel = g('export-cancel');
    const btnConfirm = g('export-confirm');
    const btnClose = g('export-close');
    const btnOcr = g('export-sugg-ocr-btn');

    input.value = defaultName;
    suggBox.innerHTML = '';

    const addSugg = (text) => {
      const clean = text.replace(/[/\\?%*:|"<>]/g, '-').trim().substring(0, 50);
      if (!clean) return;
      const chip = document.createElement('div');
      chip.className = 'sugg-chip';
      chip.title = clean;
      chip.textContent = clean;
      chip.addEventListener('click', () => {
        input.value = clean.endsWith('.pdf') ? clean : clean + '.pdf';
      });
      suggBox.appendChild(chip);
    };

    addSugg(defaultName);

    // --- エクスポートサマリーの構築 ---
    const summaryEl = g('export-summary-content');
    if (summaryEl) {
      const isCompress = g('meta-compress')?.checked;
      const isGrayscale = g('meta-grayscale')?.checked;
      const isIncludeText = g('meta-include-text')?.checked;
      const textReflectMode = g('text-reflect-mode')?.value || 'transparent';
      const isUniformA4 = g('meta-uniform-a4')?.checked;
      const uniformSize = g('uniform-size-sel')?.value || 'A4';
      const isIncludePaint = g('meta-include-paint')?.checked;
      const isMasking = g('meta-masking')?.checked;
      const isPageno = g('meta-pageno')?.checked;
      const isEncrypt = g('meta-encrypt')?.checked;

      let rasterizeReasons = [];
      if (isCompress) rasterizeReasons.push('圧縮が有効');
      if (isGrayscale) rasterizeReasons.push('白黒出力が有効');
      if (isIncludeText && (textReflectMode === 'transparent' || textReflectMode === 'overlay')) {
        rasterizeReasons.push('テキスト層の透明/オーバーレイ埋め込み');
      }

      let itemRasterizeCount = 0;
      items.forEach(it => {
        if ((it.filters && getFilterString(it.filters) !== 'none') || it.scanFixData || it.flipH || it.flipV || (isIncludePaint && it.paintData)) {
          itemRasterizeCount++;
        }
      });
      if (itemRasterizeCount > 0) rasterizeReasons.push(`個別編集(${itemRasterizeCount}ページ)が含まれるため`);

      let formatText = '';
      if (isIncludeText && textReflectMode === 'replace') {
        formatText = `<li><i class="fa-solid fa-file-pdf"></i> <div><strong>PDF再構築モード</strong> <span class="warn-text">元の画像・レイアウトを破棄し、抽出テキストのみで再構成します。</span></div></li>`;
      } else if (rasterizeReasons.length > 0) {
        formatText = `<li><i class="fa-solid fa-image"></i> <div><strong>全ページ画像化 (ラスタライズ出力)</strong> <span class="warn-text">理由: ${rasterizeReasons.join(' / ')}</span></div></li>`;
      } else {
        formatText = `<li><i class="fa-solid fa-file-pdf"></i> <div><strong>PDFネイティブ出力</strong> <br><span style="color:var(--c-t3); font-size:10.5px;">品質とページ構造を保持したまま出力します。</span></div></li>`;
      }

      let textModeStr = '反映しない';
      if (isIncludeText) {
        if (textReflectMode === 'transparent') textModeStr = '透明テキストとして埋め込み (検索・コピー可能)';
        else if (textReflectMode === 'replace') textModeStr = '白紙にテキストのみを描画';
        else if (textReflectMode === 'overlay') textModeStr = '薄い白幕の上に可視文字として描画';
      }

      const optText = `
        <li><i class="fa-solid fa-font"></i> <div><strong>テキスト情報:</strong> ${textModeStr}</div></li>
        <li><i class="fa-solid fa-maximize"></i> <div><strong>ページサイズ:</strong> ${isUniformA4 ? uniformSize + ' に統一' : '元のサイズを維持'}</div></li>
        <li><i class="fa-solid fa-shield-halved"></i> <div><strong>セキュリティ等:</strong> ${[isMasking ? '黒塗り(マスキング)有効' : null, isEncrypt ? 'パスワード無効(非対応)' : null].filter(Boolean).join(', ') || '特になし'}</div></li>
        ${isPageno ? `<li><i class="fa-solid fa-list-ol"></i> <div><strong>ページ番号:</strong> 付与する</div></li>` : ''}
      `;

      summaryEl.innerHTML = `<ul>${formatText}${optText}</ul>`;
    }
    // ----------------------------------

    const firstItem = items[0];
    const jsDoc = S.jsDocs.get(firstItem.fileId);
    if (jsDoc) {
      jsDoc.getPage(firstItem.pageIndex + 1).then(page => {
        page.getTextContent().then(tc => {
          if (tc.items.length > 0) {
            let maxH = 0;
            let titleText = '';
            tc.items.forEach(it => {
              if (it.str.trim() && it.transform[3] > maxH) {
                maxH = it.transform[3];
                titleText = it.str;
              }
            });
            if (titleText) addSugg(titleText + (isAll ? '_ALL' : '_selected') + '.pdf');
          }
        }).catch(e => console.error(e));
      }).catch(e => console.error(e));
    }

    btnOcr.onclick = async () => {
      btnOcr.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 解析中...';
      btnOcr.disabled = true;
      try {
        const worker = await OCRWorker.get();
        const page = await jsDoc.getPage(firstItem.pageIndex + 1);
        const totalRot = (page.rotate + firstItem.rotation) % 360;
        const vp = page.getViewport({ scale: 1.5, rotation: totalRot }); 
        const cnv = document.createElement('canvas');
        cnv.width = Math.round(vp.width);
        cnv.height = Math.round(vp.height);
        
        const ctx = cnv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cnv.width, cnv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        
        const cropH = Math.min(cnv.height, cnv.height * 0.3);
        const cropCnv = document.createElement('canvas');
        cropCnv.width = cnv.width;
        cropCnv.height = cropH;
        cropCnv.getContext('2d').drawImage(cnv, 0, 0, cnv.width, cropH, 0, 0, cnv.width, cropH);

        const { data: { text } } = await worker.recognize(cropCnv.toDataURL('image/png'));
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        
        if (lines.length > 0) {
          addSugg(lines[0] + (isAll ? '_ALL' : '_selected') + '.pdf');
          btnOcr.innerHTML = '<i class="fa-solid fa-check"></i> 抽出完了';
        } else {
          btnOcr.innerHTML = '<i class="fa-solid fa-xmark"></i> 見つかりませんでした';
        }
      } catch (err) {
        console.error(err);
        btnOcr.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> エラー';
      }
      setTimeout(() => {
        btnOcr.innerHTML = '<i class="fa-solid fa-language"></i> 1ページ目をOCR解析して候補を取得';
        btnOcr.disabled = false;
      }, 3000);
    };

    const cleanup = () => {
      modal.classList.add('hidden');
      btnCancel.onclick = null;
      btnConfirm.onclick = null;
      btnClose.onclick = null;
      btnOcr.onclick = null;
    };

    const confirm = () => {
      let name = input.value.trim();
      if (!name) name = defaultName;
      if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
      cleanup();
      resolve(name);
    };

    btnCancel.onclick = () => { cleanup(); resolve(null); };
    btnClose.onclick = () => { cleanup(); resolve(null); };
    btnConfirm.onclick = confirm;
    
    input.onkeydown = (e) => {
      if (e.key === 'Enter') confirm();
    };

    modal.classList.remove('hidden');
    input.focus();
    input.select();
  });
}

const expSel = async () => {
  const items = S.ws.filter(w => S.sel.has(w.id));
  const name = await getExportName(items, false);
  if (name) exportItems(items, name);
};
const expAll = async () => {
  const items = [...S.ws];
  const name = await getExportName(items, true);
  if (name) exportItems(items, name);
};

const printSel = async () => {
  const items = S.ws.filter(w => S.sel.has(w.id));
  if (!items.length) return;
  exportItems(items, null, 'print');
};
const printAll = async () => {
  const items = [...S.ws];
  if (!items.length) return;
  exportItems(items, null, 'print');
};

async function exportZip(items) {
  items = items.filter(w => w.type !== '3d');
  if (!items.length) return;
  if (typeof JSZip === 'undefined') {
    alert('JSZipライブラリが読み込まれていません。\nインターネット接続を確認してください。');
    return;
  }
  
  try {
    showProg(0, items.length, 'ZIP作成準備中');
    const zip = new JSZip();
    const isCompress = g('meta-compress')?.checked;
    const compQuality = parseFloat(g('compress-slider')?.value || "0.8");
    
    for (let i = 0; i < items.length; i++) {
      showProg(i + 1, items.length, '画像化処理中 (ZIP)');
      const item = items[i];
      const jsDoc = S.jsDocs.get(item.fileId);
      if (!jsDoc) continue;

      const page = await jsDoc.getPage(item.pageIndex + 1);
      const totalRot = (page.rotate + item.rotation) % 360;
      
      const sc = isCompress ? 1.5 : 2.0;
      const vp = page.getViewport({ scale: sc, rotation: totalRot });
      
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (item.scanFixData) {
        const img = new Image();
        img.src = item.scanFixData.dataUrl;
        await new Promise(r => { img.onload = r; });
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(item.rotation * Math.PI / 180);
        const _elw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
        const _elh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
        ctx.drawImage(img, -_elw * sc / 2, -_elh * sc / 2, _elw * sc, _elh * sc);
        ctx.restore();
      } else {
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
      
      const fStr = getFilterString(item.filters);
      if (fStr !== 'none') {
        const fCnv = document.createElement('canvas');
        fCnv.width = canvas.width; fCnv.height = canvas.height;
        fCnv.getContext('2d').filter = fStr;
        fCnv.getContext('2d').drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(fCnv, 0, 0);
      }

      let finalCanvas = canvas;
      if (item.cropBox) {
        const { x, y, width, height } = item.cropBox;
        const cw = canvas.width, ch = canvas.height;
        const cx = cw * x, cy = ch * y, cw2 = cw * width, ch2 = ch * height;
        finalCanvas = document.createElement('canvas');
        finalCanvas.width = Math.max(1, cw2); finalCanvas.height = Math.max(1, ch2);
        finalCanvas.getContext('2d').drawImage(canvas, cx, cy, cw2, ch2, 0, 0, cw2, ch2);
      }

      applyFlipToCanvas(finalCanvas, item);

      if (g('meta-include-paint')?.checked && item.paintData) {
        const img = new Image();
        img.src = item.paintData.dataUrl;
        await new Promise(r => { img.onload = r; });
        finalCanvas.getContext('2d').drawImage(img, 0, 0, finalCanvas.width, finalCanvas.height);
      }

      const quality = isCompress ? compQuality : 0.92;
      const dataUrl = finalCanvas.toDataURL('image/jpeg', quality);
      const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
      
      const f = S.files.get(item.fileId);
      const dispName = f ? (f.alias || f.name) : "page";
      const prefix = dispName.replace(/\.[^/.]+$/, "");
      let fileName = `${prefix}_${String(item.pageIndex + 1).padStart(3, '0')}.jpg`;
      
      let finalName = fileName;
      let c = 1;
      while(zip.file(finalName)) {
        finalName = `${prefix}_${String(item.pageIndex + 1).padStart(3, '0')}_(${c}).jpg`;
        c++;
      }
      
      zip.file(finalName, base64Data, {base64: true});
    }

    showProg(items.length, items.length, 'ZIP圧縮中...');
    const content = await zip.generateAsync({type:"blob"});
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PDF_Studio_Images_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

  } catch (err) {
    alert('ZIP保存エラー: ' + err.message);
    console.error(err);
  } finally {
    hideProg();
  }
}

// ============================================================
// HELPERS — テキスト層の有意性チェック
// ============================================================
/**
 * PDF.js getTextContent() の結果から有意なテキストがあるか判定する。
 * 空白・改行のみのページや画像化されたページは false を返す。
 */
async function pageHasText(page) {
  try {
    const tc = await page.getTextContent();
    const raw = tc.items.map(it => it.str).join('');
    return raw.replace(/\s+/g, '').length >= TEXT_LAYER_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * PDF.js getTextContent() の結果から読みやすいテキストを取得する。
 * 改行と空白を保持しながら連結する。
 */
async function extractPageText(page) {
  try {
    const tc = await page.getTextContent();
    const lines = [];
    let lastY = null;
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push('\n');
      }
      lines.push(item.str);
      lastY = y;
    }
    return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

// ============================================================
// SHARED OCR WORKER (Tesseract.js) — 遅延初期化・再利用
// ============================================================
const OCRWorker = (() => {
  let _w = null;
  async function get() {
    if (!_w) {
      _w = await Tesseract.createWorker('jpn+eng');
      // 日本語メイン・英数字サブの認識精度向上設定
      await _w.setParameters({
        preserve_interword_spaces: '1',   // 単語間スペースを保持
        tessedit_pageseg_mode: '3',       // PSM_AUTO: 全自動レイアウト解析
      });
    }
    return _w;
  }
  return { get };
})();

// ============================================================
// PAGE VIEWER (lightbox)
// ============================================================
const Viewer = (() => {
  let _open           = false;
  let _items          = [];
  let _idx            = 0;
  let _token          = 0;
  let _currentId      = null;
  let _currentTab     = 'render';   
  let _textCache      = new Map();  
  let _resizeObs      = null;
  let _resizeTimer    = null;
  let _pageLayout     = 'single';   // 'single', 'double'
 let _originalLayout = 'single';   // 比較モード用退避
  let _compareMode    = false;      // 比較モードフラグ
  let _compareIds     = [];         // 比較モード時の左右のID
  let _isScroll       = false;      // スクロールモードのON/OFF
  let _fitMode        = 'contain';  // 'contain', '100', 'w', 'h', 'zoom'
  let _zoomLevel      = 1.0;        // zoom モード時の倍率 (1.0 = contain と同等)
  let _scrollObserver = null;       // スクロール時の遅延レンダリング用

  let _renderTaskL    = null;       // PDF.jsのレンダリングタスク(左)
  let _renderTaskR    = null;       // PDF.jsのレンダリングタスク(右)

  const closeEditUIs = () => {
      const adjUI = g('viewer-adjust-ui');
      if (adjUI && !adjUI.classList.contains('hidden')) {
        adjUI.classList.add('hidden');
        g('vhd-adjust')?.classList.remove('active');
      }
      const paintUI = g('viewer-paint-ui');
      if (paintUI && !paintUI.classList.contains('hidden')) {
        paintUI.classList.add('hidden');
        g('vhd-paint')?.classList.remove('active');
        const pc = g('viewer-paint-canvas');
        if (pc) pc.style.display = 'none';
        g('viewer-canvas')?.classList.remove('paint-active');
        // カーソルオーバーレイも隠す
        const cc = document.getElementById('paint-cursor-canvas');
        if (cc) cc.style.display = 'none';
        const panel = g('viewer-render-panel');
        if (panel) panel.style.touchAction = '';
      }
      const cropUI = g('viewer-crop-ui');
    if (cropUI && !cropUI.classList.contains('hidden')) {
      cropUI.classList.add('hidden');
      g('vhd-crop')?.classList.remove('active');
    }
    const scanfixUI = g('viewer-scanfix-ui');
    if (scanfixUI && !scanfixUI.classList.contains('hidden')) {
      scanfixUI.classList.add('hidden');
      g('vhd-scanfix')?.classList.remove('active');
      g('viewer-scanfix-overlay')?.classList.add('hidden');
      const vc = g('viewer-canvas');
      if (vc) vc.style.display = 'block';
    }
  };

  function detectMojibake(text) {
    if (!text) return false;
    if (text.split('').length > 3) return true; 
    const match = text.match(/[縺繝縲鐚-鐡]/g); 
    if (match && match.length >= 2) return true;
    return false;
  }

  function fixMojibake(text, encoding) {
    try {
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      return text;
    }
  }

  function buildDOM() {
    document.querySelectorAll('.adj-close-btn').forEach(btn => {
      btn.addEventListener('click', () => closeEditUIs());
    });

    const renderPanel = g('viewer-render-panel');
    if (renderPanel) {
      renderPanel.addEventListener('contextmenu', e => {
        if (!_items[_idx] || _isScroll) return;
        e.preventDefault();
        e.stopPropagation();
        ContextMenu.show(_items[_idx].id, e.clientX, e.clientY);
      });
      // 比較モード用ナビゲーションのホバー制御
      renderPanel.addEventListener('mousemove', e => {
        if (!_compareMode) return;
        const canvasL = g('viewer-canvas');
        const canvasR = g('viewer-canvas-right');
        const navL = g('compare-nav-left');
        const navR = g('compare-nav-right');
        
        if (canvasL && navL) {
          const r = canvasL.getBoundingClientRect();
          const inL = e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
          navL.classList.toggle('hover-active', inL);
        }
        if (canvasR && navR && canvasR.style.display !== 'none') {
          const r = canvasR.getBoundingClientRect();
          const inR = e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
          navR.classList.toggle('hover-active', inR);
        }
      });
      // カーソルが外れたら非表示
      renderPanel.addEventListener('mouseleave', () => {
        if (!_compareMode) return;
        g('compare-nav-left')?.classList.remove('hover-active');
        g('compare-nav-right')?.classList.remove('hover-active');
      });
    }

    const tDeepL = g('viewer-trans-deepl');
    const tGoogle = g('viewer-trans-google');
    const tSettings = g('viewer-trans-settings');
    const getSelText = () => {
      const ta = g('viewer-text-area');
      return ta.value.substring(ta.selectionStart, ta.selectionEnd) || ta.value;
    };
    
    tDeepL?.addEventListener('click', () => {
      const text = getSelText();
      if (!text) return;
      const urlTmpl = localStorage.getItem('pdf_studio_url_deepl') || 'https://www.deepl.com/ja/translator#ja/en/{text}';
      window.open(urlTmpl.replace('{text}', encodeURIComponent(text)), '_blank');
    });

    tGoogle?.addEventListener('click', () => {
      const text = getSelText();
      if (!text) return;
      const urlTmpl = localStorage.getItem('pdf_studio_url_google') || 'https://translate.google.co.jp/?sl=auto&tl=ja&text={text}&op=translate';
      window.open(urlTmpl.replace('{text}', encodeURIComponent(text)), '_blank');
    });

    tSettings?.addEventListener('click', () => {
      g('trans-url-deepl').value = localStorage.getItem('pdf_studio_url_deepl') || 'https://www.deepl.com/ja/translator#ja/en/{text}';
      g('trans-url-google').value = localStorage.getItem('pdf_studio_url_google') || 'https://translate.google.co.jp/?sl=auto&tl=ja&text={text}&op=translate';
      g('trans-settings-overlay').classList.remove('hidden');
    });

    g('trans-close')?.addEventListener('click', () => g('trans-settings-overlay').classList.add('hidden'));
    g('trans-save')?.addEventListener('click', () => {
      localStorage.setItem('pdf_studio_url_deepl', g('trans-url-deepl').value);
      localStorage.setItem('pdf_studio_url_google', g('trans-url-google').value);
      g('trans-settings-overlay').classList.add('hidden');
    });

    g('viewer-overlay').addEventListener('click', e => {
      if (e.target === g('viewer-overlay')) close();
    });
    g('vhd-close').addEventListener('click', close);
    g('vnav-prev').addEventListener('click', () => navigate(-1));
    g('vnav-next').addEventListener('click', () => navigate(1));
    
    // 比較モード用左右独立ナビゲーション
    const cmpNavigate = (side, delta) => {
      const idxObj = _items.findIndex(w => w.id === _compareIds[side]);
      if (idxObj < 0) return;
      let nextIdx = idxObj + delta;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= _items.length) nextIdx = _items.length - 1;
      
      const nextId = _items[nextIdx].id;
      // 重複チェック (同一ページを開かない)
      if (nextId === _compareIds[1 - side]) {
        nextIdx += delta;
        if (nextIdx < 0 || nextIdx >= _items.length) return; 
      }
      _compareIds[side] = _items[nextIdx].id;
      requestAnimationFrame(() => render());
    };
    g('vnav-cmp-l-prev')?.addEventListener('click', () => cmpNavigate(0, -1));
    g('vnav-cmp-l-next')?.addEventListener('click', () => cmpNavigate(0, 1));
    g('vnav-cmp-r-prev')?.addEventListener('click', () => cmpNavigate(1, -1));
    g('vnav-cmp-r-next')?.addEventListener('click', () => cmpNavigate(1, 1));

    g('vhd-rot-l').addEventListener('click', () => { if (_items[_idx]) rotatePage(_items[_idx].id, -90); });
    g('vhd-rot-r').addEventListener('click', () => { if (_items[_idx]) rotatePage(_items[_idx].id, 90); });
    g('vhd-flip-h')?.addEventListener('click', () => {
      if (!_items[_idx]) return;
      flipPage(_items[_idx].id, 'h');
      requestAnimationFrame(() => render());
      g('vhd-flip-h').classList.toggle('active', !!_items[_idx]?.flipH);
    });
    g('vhd-flip-v')?.addEventListener('click', () => {
      if (!_items[_idx]) return;
      flipPage(_items[_idx].id, 'v');
      requestAnimationFrame(() => render());
      g('vhd-flip-v').classList.toggle('active', !!_items[_idx]?.flipV);
    });
    g('vhd-props').addEventListener('click', () => { if (_items[_idx]) DocProps.open(_items[_idx].fileId); });
    g('vhd-ocr').addEventListener('click', () => { if (_items[_idx] && _items[_idx].type !== '3d') OCR.runForItem(_items[_idx]); });
    
    g('vhd-qr')?.addEventListener('click', () => { decodeQR(); });

    g('vhd-dl-img')?.addEventListener('click', () => {
      if (!_items[_idx] || _pageLayout !== 'single') {
        alert('画像の保存は単一ページ表示時のみ使用可能です');
        return;
      }
      const canvas = g('viewer-canvas');
      if (!canvas) return;
      const item = _items[_idx];
      const tempCnv = document.createElement('canvas');
      tempCnv.width = canvas.width;
      tempCnv.height = canvas.height;
      const ctx = tempCnv.getContext('2d');
      const filterStr = canvas.style.filter;
      if (filterStr && filterStr !== 'none') ctx.filter = filterStr;
      ctx.drawImage(canvas, 0, 0);
      const dataUrl = tempCnv.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      const f = S.files.get(item.fileId);
      const baseName = f ? f.name.replace(/\.pdf$/i, '') : 'page';
      a.download = `${baseName}_p${item.pageIndex + 1}.png`;
      a.click();
    });

    // オートフィットボタン
    const syncZoomSlider = (level) => {
      const sl = g('vhd-zoom-slider');
      const vl = g('vhd-zoom-val');
      if (sl) sl.value = Math.round(level * 100);
      if (vl) vl.textContent = Math.round(level * 100) + '%';
    };

    const setFit = (mode) => {
      _fitMode   = mode;
      _zoomLevel = 1.0;
      syncZoomSlider(1.0);
      g('vhd-fit-100')?.classList.toggle('active', mode === '100');
      g('vhd-fit-w')?.classList.toggle('active', mode === 'w');
      g('vhd-fit-h')?.classList.toggle('active', mode === 'h');
      if (_open && _items[_idx]) requestAnimationFrame(() => {
        closeEditUIs();
        render();
      });
    };
    g('vhd-fit-100')?.addEventListener('click', () => setFit(_fitMode === '100' ? 'contain' : '100'));
    g('vhd-fit-w')?.addEventListener('click', () => setFit(_fitMode === 'w' ? 'contain' : 'w'));
    g('vhd-fit-h')?.addEventListener('click', () => setFit(_fitMode === 'h' ? 'contain' : 'h'));

    // ズームスライダー
    const zoomSlider = g('vhd-zoom-slider');
    const zoomVal    = g('vhd-zoom-val');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', () => {
        _zoomLevel = Number(zoomSlider.value) / 100;
        if (zoomVal) zoomVal.textContent = zoomSlider.value + '%';
        _fitMode = 'zoom';
        g('vhd-fit-100')?.classList.remove('active');
        g('vhd-fit-w')?.classList.remove('active');
        g('vhd-fit-h')?.classList.remove('active');
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
          if (_open && _items.length > 0) requestAnimationFrame(() => {
            closeEditUIs();
            render();
          });
        }, 40);
      });
    }

    const setPageLayout = (layout) => {
      if (_pageLayout === layout) return;
      closeEditUIs();
      _pageLayout = layout;
      
      // 見開き表示への切り替え時に奇数ページなら前の偶数ページへ調整
      if (layout === 'double' && _idx % 2 !== 0) {
        _idx = Math.max(0, _idx - 1);
        if (_items[_idx]) _currentId = _items[_idx].id;
        updateHeader();
      }

      g('vhd-view-single')?.classList.toggle('active', layout === 'single');
      g('vhd-view-double')?.classList.toggle('active', layout === 'double');
      
      initRenderPanelDOM();
      if (_open && _items.length > 0) {
        requestAnimationFrame(() => {
          render();
          if (_isScroll) scrollToCurrent();
        });
      }
    };

    const toggleScrollMode = () => {
      closeEditUIs();
      _isScroll = !_isScroll;
      g('vhd-view-scroll')?.classList.toggle('active', _isScroll);
      
      initRenderPanelDOM();
      if (_open && _items.length > 0) {
        requestAnimationFrame(() => {
          render();
          if (_isScroll) scrollToCurrent();
        });
      }
    };

    const scrollToCurrent = () => {
      const wrap = g('viewer-page-wrap');
      // 見開きの場合はベースとなるインデックスを探す
      const targetIdx = _pageLayout === 'double' ? _idx - (_idx % 2) : _idx;
      const targetDiv = wrap.querySelector(`.scroll-page-wrap[data-idx="${targetIdx}"]`);
      const renderPanel = g('viewer-render-panel');
      if (targetDiv && renderPanel) renderPanel.scrollTop = targetDiv.offsetTop - 24;
    };

    g('vhd-view-single')?.addEventListener('click', () => setPageLayout('single'));
    g('vhd-view-double')?.addEventListener('click', () => setPageLayout('double'));
    g('vhd-view-scroll')?.addEventListener('click', toggleScrollMode);

    // 画像調整UIロジック
    const adjustBtn = g('vhd-adjust');
    const adjustUI = g('viewer-adjust-ui');

    const adjBr = g('adj-br'), adjCt = g('adj-ct'), adjSa = g('adj-sa'), adjBl = g('adj-bl');
    const valBr = g('adj-val-br'), valCt = g('adj-val-ct'), valSa = g('adj-val-sa'), valBl = g('adj-val-bl');

    const updateAdjustUI = () => {
      const filters = _items[_idx]?.filters || { br: 100, ct: 100, sa: 100, bl: 0 };
      if (adjBr) adjBr.value = filters.br;
      if (adjCt) adjCt.value = filters.ct;
      if (adjSa) adjSa.value = filters.sa;
      if (adjBl) adjBl.value = filters.bl;
      if (valBr) valBr.textContent = filters.br + '%';
      if (valCt) valCt.textContent = filters.ct + '%';
      if (valSa) valSa.textContent = filters.sa + '%';
      if (valBl) valBl.textContent = filters.bl + 'px';
      applyCanvasFilter(filters);
    };

    const applyCanvasFilter = (filters) => {
      const cL = g('viewer-canvas');
      const cR = g('viewer-canvas-right');
      const fStr = getFilterString(filters);
      if (cL) cL.style.filter = fStr;
      if (cR) cR.style.filter = fStr;
    };

    let _tempFilters = null;

    [adjBr, adjCt, adjSa, adjBl].forEach(el => {
      if (!el) return;
      el.addEventListener('input', () => {
        if (valBr) valBr.textContent = adjBr.value + '%';
        if (valCt) valCt.textContent = adjCt.value + '%';
        if (valSa) valSa.textContent = adjSa.value + '%';
        if (valBl) valBl.textContent = adjBl.value + 'px';
        _tempFilters = {
          br: parseInt(adjBr.value, 10),
          ct: parseInt(adjCt.value, 10),
          sa: parseInt(adjSa.value, 10),
          bl: parseInt(adjBl.value, 10)
        };
        applyCanvasFilter(_tempFilters);
      });
    });

    g('adj-reset')?.addEventListener('click', () => {
      if (adjBr) adjBr.value = 100;
      if (adjCt) adjCt.value = 100;
      if (adjSa) adjSa.value = 100;
      if (adjBl) adjBl.value = 0;
      if (valBr) valBr.textContent = '100%';
      if (valCt) valCt.textContent = '100%';
      if (valSa) valSa.textContent = '100%';
      if (valBl) valBl.textContent = '0px';
      _tempFilters = null;
      applyCanvasFilter(null);
    });

    g('adj-cancel')?.addEventListener('click', () => {
      _tempFilters = null;
      applyCanvasFilter(_items[_idx]?.filters || null);
      closeEditUIs();
    });

    g('adj-apply')?.addEventListener('click', async () => {
      const item = _items[_idx];
      if (!item) return;
      if (_tempFilters) {
        item.filters = _tempFilters;
      }
      
      const ld = g('viewer-ld');
      if (ld) ld.style.display = 'flex';
      
      await commitItemEdits(item);
      
      saveState('画像調整の適用');
      closeEditUIs();
      thumbQ(() => genThumb(item)).then(() => {
        if (_items[_idx]?.id === item.id) render();
      });
    });

    adjustBtn?.addEventListener('click', () => {
      _tempFilters = null;
      if (!_items[_idx] || _pageLayout !== 'single' || _isScroll) {
        alert('画像調整は「単一表示」モード時のみ使用可能です。右上から単一表示[1]に切り替えてください。');
        return;
      }
      const isAdjusting = !adjustUI.classList.contains('hidden');
      if (isAdjusting) {
        closeEditUIs();
        return;
      }
      closeEditUIs();
      adjustBtn.classList.add('active');
      adjustUI.classList.remove('hidden');
      updateAdjustUI();
    });

    // ── ペイントUIロジック ────────────────────────────────────
    const paintBtn = g('vhd-paint');
    const paintUI  = g('viewer-paint-ui');
    let paintTool  = 'pen';
    let paintColor = '#ef4444';
    let paintSize  = 3;
    let paintOpacity = 1.0;
    let paintHistory = []; // {imageData} スタック
    let paintDraw = { active: false, sx: 0, sy: 0, snap: null };

    function getPaintCanvas() { return g('viewer-paint-canvas'); }
    function getPaintCtx()    { const c = getPaintCanvas(); return c ? c.getContext('2d') : null; }

    function syncPaintCanvas() {
      const base = g('viewer-canvas');
      const pc   = getPaintCanvas();
      if (!base || !pc) return;
      pc.width  = base.width;
      pc.height = base.height;
      // offsetWidth / offsetHeight を使用し、実際の表示サイズに合わせることで
      // max-width等による縮小表示時でも座標がずれないようにする
      // 非同期描画等で一時的に0になる不具合を防ぐためのフォールバックを追加
      const bw = base.offsetWidth || parseFloat(base.style.width) || base.width;
      const bh = base.offsetHeight || parseFloat(base.style.height) || base.height;
      pc.style.width  = bw + 'px';
      pc.style.height = bh + 'px';
      pc.style.left   = base.offsetLeft + 'px';
      pc.style.top    = base.offsetTop  + 'px';
    }

    function pushPaintHistory() {
      const ctx = getPaintCtx();
      const pc  = getPaintCanvas();
      if (!ctx || !pc) return;
      if (paintHistory.length === 0) {
        // 初回プッシュ時は初期状態（透明）を底に入れておく
        const blank = new ImageData(pc.width, pc.height);
        paintHistory.push(blank);
      }
      paintHistory.push(ctx.getImageData(0, 0, pc.width, pc.height));
      if (paintHistory.length > 30) paintHistory.shift();
    }

    function paintUndo() {
      if (paintHistory.length === 0) return;
      const ctx = getPaintCtx();
      const pc  = getPaintCanvas();
      if (!ctx || !pc) return;
      
      // 直前の状態を取り出す
      const prev = paintHistory.pop();
      ctx.putImageData(prev, 0, 0);
      
      // スタックが空になったら、今の状態（初期状態など）を再度底に入れておく
      if (paintHistory.length === 0) {
        paintHistory.push(prev);
      }
    }

    function paintClear() {
      const ctx = getPaintCtx();
      const pc  = getPaintCanvas();
      if (!ctx || !pc) return;
      pushPaintHistory();
      ctx.clearRect(0, 0, pc.width, pc.height);
    }

    async function paintApply() {
      const base = g('viewer-canvas');
      const pc   = getPaintCanvas();
      if (!base || !pc) return;
      const item = _items[_idx];
      if (!item) return;

      const ld = g('viewer-ld');
      if (ld) ld.style.display = 'flex';

      const paintLayer = document.createElement('canvas');
      paintLayer.width = base.width;
      paintLayer.height = base.height;
      const pCtx = paintLayer.getContext('2d');

      if (item.paintData) {
        const img = new Image();
        img.src = item.paintData.dataUrl;
        await new Promise(r => { img.onload = r; });
        pCtx.drawImage(img, 0, 0, base.width, base.height);
      }
      pCtx.drawImage(pc, 0, 0);

      item.paintData = {
        dataUrl: paintLayer.toDataURL('image/png'),
        width: base.width,
        height: base.height
      };

      getPaintCtx().clearRect(0, 0, pc.width, pc.height);
      paintHistory = [];
      closeEditUIs();

      await commitItemEdits(item);

      saveState('ペイントの適用');
      thumbQ(() => genThumb(item)).then(() => {
        if (_items[_idx]?.id === item.id) render();
      });
    }

    // ─── ペイントカーソル補助レイヤー ─────────────────────────────
    // ペン経路・太さ・消しゴム範囲をリアルタイムで可視化するオーバーレイ
    let _paintCursor = null;

    function getPaintCursor() {
      if (_paintCursor) return _paintCursor;
      _paintCursor = document.createElement('canvas');
      _paintCursor.id = 'paint-cursor-canvas';
      _paintCursor.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:9999;display:none;';
      document.body.appendChild(_paintCursor);
      return _paintCursor;
    }

    function syncCursorCanvas() {
      const cc = getPaintCursor();
      if (!cc) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cc.width !== window.innerWidth * dpr || cc.height !== window.innerHeight * dpr) {
        cc.width  = window.innerWidth * dpr;
        cc.height = window.innerHeight * dpr;
        cc.style.width  = window.innerWidth + 'px';
        cc.style.height = window.innerHeight + 'px';
        cc.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
        cc.getContext('2d').scale(dpr, dpr);
      }
    }

    // カーソルオーバーレイ描画（ツール種別・位置・サイズを視覚化）
    function drawCursorOverlay(x, y, isActive, drawExtra = null) {
      const cc = getPaintCursor();
      const pc = getPaintCanvas();
      if (!cc || !pc) return;
      const ctx = cc.getContext('2d');
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const rect = pc.getBoundingClientRect();
      const scaleX = rect.width / pc.width;
      const scaleY = rect.height / pc.height;
      const screenX = rect.left + x * scaleX;
      const screenY = rect.top + y * scaleY;

      // 追加の描画（ドラッグ中の仮プレビュー線など）
      if (drawExtra) {
        ctx.save();
        ctx.translate(rect.left, rect.top);
        ctx.scale(scaleX, scaleY);
        drawExtra(ctx);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(screenX, screenY);

      const r = paintSize / 2 * scaleX;
      const isEraser = paintTool === 'eraser';
      const isFillPen = paintTool === 'fill-pen';
      const isText = paintTool === 'text';
      const isStamp = paintTool === 'stamp';

      if (isText || isStamp) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = paintColor;
        ctx.scale(scaleX, scaleY);
        if (isText) {
          const textVal = (g('paint-text-input')?.value || '').trim();
          if (textVal) {
            const fontF = g('paint-text-font')?.value || 'sans-serif';
            const fontS = g('paint-text-size')?.value || '24';
            ctx.font = `${fontS}px ${fontF}`;
            ctx.textBaseline = 'top';
            ctx.fillText(textVal, 0, 0);
          }
        } else if (isStamp) {
          const stampVal = g('paint-stamp-sel')?.value || '✔';
          const fontS = Math.max(paintSize * 8, 32);
          ctx.font = `bold ${fontS}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          if (stampVal === '✔' || stampVal === '✘') {
            ctx.fillText(stampVal, 0, 0);
          } else {
            ctx.rotate(-15 * Math.PI / 180);
            const m = ctx.measureText(stampVal);
            const tw = m.width, th = fontS;
            const padX = fontS * 0.4, padY = fontS * 0.2;
            ctx.lineWidth = Math.max(2, fontS * 0.08);
            ctx.strokeStyle = paintColor;
            const rx = -tw/2 - padX, ry = -th/2 - padY, rw = tw + padX*2, rh = th + padY*2, rad = fontS*0.2;
            ctx.beginPath();
            ctx.moveTo(rx + rad, ry);
            ctx.lineTo(rx + rw - rad, ry); ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
            ctx.lineTo(rx + rw, ry + rh - rad); ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
            ctx.lineTo(rx + rad, ry + rh); ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
            ctx.lineTo(rx, ry + rad); ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
            ctx.closePath();
            ctx.stroke();
            ctx.fillText(stampVal, 0, fontS * 0.05);
          }
        }
      } else {
        // ─ カーソルリング ─
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(r, 2), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, Math.max(r, 2), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        if (isFillPen) {
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(r, 2), 0, Math.PI * 2);
          ctx.fillStyle = paintColor + '55';   
          ctx.fill();
        }
      }
      ctx.restore();

      // ─ アクティブドロー中：最新ポイントにパルスリング ─
      if (isActive && !isText && !isStamp) {
        ctx.save();
        ctx.translate(screenX, screenY);
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(r, 2) + 6, 0, Math.PI * 2);
        ctx.strokeStyle = isEraser ? 'rgba(239,68,68,0.7)' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
      }
    }

    function hideCursorOverlay() {
      const cc = _paintCursor;
      if (!cc) return;
      cc.getContext('2d').clearRect(0, 0, cc.width, cc.height);
    }

    function setupPaintEvents() {
      const panel = g('viewer-render-panel');
      if (!panel) return;

      const getPos = (e, currentPc) => {
        const rect = currentPc.getBoundingClientRect();
        const scaleX = currentPc.width  / rect.width;
        const scaleY = currentPc.height / rect.height;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top)  * scaleY,
        };
      };

      const applyStyle = (ctx) => {
        ctx.strokeStyle = paintColor;
        ctx.fillStyle   = paintColor;
        ctx.lineWidth   = paintSize;
        ctx.globalAlpha = paintOpacity;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
      };

      let _fillPenSnap = null;
      let _fillPenPath = [];

      const drawFillPenPreview = (ctx, cx, cy) => {
        if (!_fillPenSnap || _fillPenPath.length < 2) return;
        ctx.putImageData(_fillPenSnap, 0, 0);
        ctx.save();
        ctx.strokeStyle = paintColor;
        ctx.lineWidth   = paintSize;
        ctx.globalAlpha = paintOpacity;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.beginPath();
        ctx.moveTo(_fillPenPath[0].x, _fillPenPath[0].y);
        for (let i = 1; i < _fillPenPath.length; i++) {
          ctx.lineTo(_fillPenPath[i].x, _fillPenPath[i].y);
        }
        ctx.stroke();
        const last = _fillPenPath[_fillPenPath.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, paintSize / 2, 0, Math.PI * 2);
        ctx.fillStyle   = 'rgba(255,255,255,0.35)';
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.restore();
      };

      const isUI = (e) => e.target.closest('#viewer-paint-ui') || e.target.closest('.vhd-btn') || e.target.closest('.adj-header');
      const isPainting = () => !g('viewer-paint-ui').classList.contains('hidden');

      panel.addEventListener('pointerenter', (e) => {
        if (!isPainting() || isUI(e)) return;
        const pc = getPaintCanvas();
        if (!pc) return;
        const cc = getPaintCursor();
        if (cc) cc.style.display = 'block';
        syncCursorCanvas();
        const { x, y } = getPos(e, pc);
        drawCursorOverlay(x, y, false);
      });
      
      panel.addEventListener('pointerleave', () => {
        if (!isPainting() || paintDraw.active) return;
        hideCursorOverlay();
        const cc = getPaintCursor();
        if (cc) cc.style.display = 'none';
      });

      panel.addEventListener('pointerdown', (e) => {
        if (!isPainting() || isUI(e) || (e.button && e.button !== 0)) return;
        e.preventDefault();
        const pc = getPaintCanvas();
        if (!pc) return;
        const { x, y } = getPos(e, pc);
        const ctx = getPaintCtx();
        if (!ctx) return;

        if (paintTool === 'text' || paintTool === 'stamp') {
          pushPaintHistory();
          applyStyle(ctx);
          
          if (paintTool === 'text') {
            const textVal = (g('paint-text-input')?.value || '').trim();
            if (!textVal) { paintHistory.pop(); return; }
            const fontF = g('paint-text-font')?.value || 'sans-serif';
            const fontS = g('paint-text-size')?.value || '24';
            ctx.font = `${fontS}px ${fontF}`;
            ctx.textBaseline = 'top';
            ctx.fillText(textVal, x, y);
          } else if (paintTool === 'stamp') {
            const stampVal = g('paint-stamp-sel')?.value || '✔';
            const fontS = Math.max(paintSize * 8, 32);
            ctx.font = `bold ${fontS}px sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            
            ctx.save();
            ctx.translate(x, y);
            
            if (stampVal === '✔' || stampVal === '✘') {
              ctx.fillText(stampVal, 0, 0);
            } else {
              ctx.rotate(-15 * Math.PI / 180);
              const m = ctx.measureText(stampVal);
              const tw = m.width;
              const th = fontS;
              const padX = fontS * 0.4;
              const padY = fontS * 0.2;
              
              ctx.lineWidth = Math.max(2, fontS * 0.08);
              ctx.strokeStyle = paintColor;
              const rx = -tw/2 - padX, ry = -th/2 - padY, rw = tw + padX*2, rh = th + padY*2, r = fontS*0.2;
              ctx.beginPath();
              ctx.moveTo(rx + r, ry);
              ctx.lineTo(rx + rw - r, ry); ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
              ctx.lineTo(rx + rw, ry + rh - r); ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
              ctx.lineTo(rx + r, ry + rh); ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
              ctx.lineTo(rx, ry + r); ctx.quadraticCurveTo(rx, ry, rx + r, ry);
              ctx.closePath();
              ctx.stroke();
              
              ctx.fillText(stampVal, 0, fontS * 0.05);
            }
            ctx.restore();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
          }
          
          drawCursorOverlay(x, y, false);
          return;
        }

        pushPaintHistory();
        paintDraw.active = true;
        paintDraw.sx = x;
        paintDraw.sy = y;
        paintDraw.eraserMode = paintTool === 'eraser';
        paintDraw.snap = ctx.getImageData(0, 0, pc.width, pc.height);

        if (paintTool === 'pen' || paintTool === 'eraser') {
          ctx.save();
          if (paintTool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
          applyStyle(ctx);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.restore();
        } else if (paintTool === 'fill-pen') {
          _fillPenSnap = ctx.getImageData(0, 0, pc.width, pc.height);
          _fillPenPath = [{ x, y }];
        }
        panel.setPointerCapture(e.pointerId);
        drawCursorOverlay(x, y, true);
      });

      panel.addEventListener('pointermove', (e) => {
        if (!isPainting()) return;
        if (isUI(e)) {
          hideCursorOverlay();
          const cc = getPaintCursor();
          if (cc) cc.style.display = 'none';
          return;
        }
        
        const cc = getPaintCursor();
        if (cc && cc.style.display === 'none') {
          cc.style.display = 'block';
          syncCursorCanvas();
        }
        
        const pc = getPaintCanvas();
        if (!pc) return;
        let { x, y } = getPos(e, pc);
        
        if (paintDraw.active && e.shiftKey) {
          if (paintTool === 'line' || paintTool === 'arrow') {
            const dx = x - paintDraw.sx;
            const dy = y - paintDraw.sy;
            const angle = Math.atan2(dy, dx);
            const dist = Math.hypot(dx, dy);
            const snapAngle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
            x = paintDraw.sx + dist * Math.cos(snapAngle);
            y = paintDraw.sy + dist * Math.sin(snapAngle);
          } else if (paintTool === 'rect' || paintTool === 'fill-rect' || paintTool === 'fill-ellipse') {
            const dx = x - paintDraw.sx;
            const dy = y - paintDraw.sy;
            const size = Math.max(Math.abs(dx), Math.abs(dy));
            x = paintDraw.sx + size * Math.sign(dx || 1);
            y = paintDraw.sy + size * Math.sign(dy || 1);
          }
        }

        if (!paintDraw.active) {
          drawCursorOverlay(x, y, false);
          return;
        }

        e.preventDefault();
        const ctx = getPaintCtx();
        if (!ctx) return;

        if (paintTool === 'pen' || paintTool === 'eraser') {
          ctx.save();
          ctx.strokeStyle = paintColor;
          ctx.lineWidth   = paintSize;
          ctx.globalAlpha = paintOpacity;
          ctx.lineCap     = 'round';
          ctx.lineJoin    = 'round';
          if (paintDraw.eraserMode) ctx.globalCompositeOperation = 'destination-out';
          ctx.beginPath();
          ctx.moveTo(paintDraw.sx, paintDraw.sy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.restore();
          paintDraw.sx = x;
          paintDraw.sy = y;
          drawCursorOverlay(x, y, true);
        } else if (paintTool === 'fill-pen') {
          _fillPenPath.push({ x, y });
          drawFillPenPreview(ctx, x, y);
          drawCursorOverlay(x, y, true);
        } else {
          ctx.putImageData(paintDraw.snap, 0, 0);
          
          drawCursorOverlay(x, y, true, (overlayCtx) => {
            applyStyle(overlayCtx);
            overlayCtx.beginPath();
            if (paintTool === 'line') {
              overlayCtx.moveTo(paintDraw.sx, paintDraw.sy);
              overlayCtx.lineTo(x, y);
              overlayCtx.stroke();
            } else if (paintTool === 'rect') {
              overlayCtx.strokeRect(paintDraw.sx, paintDraw.sy, x - paintDraw.sx, y - paintDraw.sy);
            } else if (paintTool === 'fill-rect') {
              overlayCtx.fillRect(paintDraw.sx, paintDraw.sy, x - paintDraw.sx, y - paintDraw.sy);
              overlayCtx.save();
              overlayCtx.globalAlpha = Math.min(paintOpacity + 0.25, 1);
              overlayCtx.strokeStyle = 'rgba(255,255,255,0.6)';
              overlayCtx.lineWidth   = 1.5;
              overlayCtx.strokeRect(paintDraw.sx, paintDraw.sy, x - paintDraw.sx, y - paintDraw.sy);
              overlayCtx.restore();
            } else if (paintTool === 'fill-ellipse') {
              const cx = (paintDraw.sx + x) / 2;
              const cy = (paintDraw.sy + y) / 2;
              const rx = Math.abs(x - paintDraw.sx) / 2;
              const ry = Math.abs(y - paintDraw.sy) / 2;
              overlayCtx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
              overlayCtx.fill();
              overlayCtx.save();
              overlayCtx.globalAlpha = Math.min(paintOpacity + 0.25, 1);
              overlayCtx.strokeStyle = 'rgba(255,255,255,0.6)';
              overlayCtx.lineWidth   = 1.5;
              overlayCtx.beginPath();
              overlayCtx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
              overlayCtx.stroke();
              overlayCtx.restore();
            } else if (paintTool === 'arrow') {
              overlayCtx.moveTo(paintDraw.sx, paintDraw.sy);
              overlayCtx.lineTo(x, y);
              overlayCtx.stroke();
              const angle = Math.atan2(y - paintDraw.sy, x - paintDraw.sx);
              const headLen = Math.max(paintSize * 4, 12);
              overlayCtx.beginPath();
              overlayCtx.moveTo(x, y);
              overlayCtx.lineTo(x - headLen * Math.cos(angle - Math.PI/7), y - headLen * Math.sin(angle - Math.PI/7));
              overlayCtx.moveTo(x, y);
              overlayCtx.lineTo(x - headLen * Math.cos(angle + Math.PI/7), y - headLen * Math.sin(angle + Math.PI/7));
              overlayCtx.stroke();
            }
          });
        }
      });

      panel.addEventListener('pointerup', (e) => {
        if (!paintDraw.active) return;
        panel.releasePointerCapture(e.pointerId);
        const pc = getPaintCanvas();
        const ctx = getPaintCtx();
        if (ctx && paintDraw.snap && ['line', 'rect', 'fill-rect', 'fill-ellipse', 'arrow'].includes(paintTool)) {
          let { x, y } = getPos(e, pc);
          let finalX = x, finalY = y;
          if (e.shiftKey) {
            if (paintTool === 'line' || paintTool === 'arrow') {
              const dx = x - paintDraw.sx, dy = y - paintDraw.sy;
              const angle = Math.atan2(dy, dx), dist = Math.hypot(dx, dy);
              const snapAngle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
              finalX = paintDraw.sx + dist * Math.cos(snapAngle);
              finalY = paintDraw.sy + dist * Math.sin(snapAngle);
            } else if (paintTool === 'rect' || paintTool === 'fill-rect' || paintTool === 'fill-ellipse') {
              const dx = x - paintDraw.sx, dy = y - paintDraw.sy;
              const size = Math.max(Math.abs(dx), Math.abs(dy));
              finalX = paintDraw.sx + size * Math.sign(dx || 1);
              finalY = paintDraw.sy + size * Math.sign(dy || 1);
            }
          }

          ctx.putImageData(paintDraw.snap, 0, 0);
          ctx.save();
          applyStyle(ctx);
          ctx.beginPath();

          if (paintTool === 'line') {
            ctx.moveTo(paintDraw.sx, paintDraw.sy);
            ctx.lineTo(finalX, finalY);
            ctx.stroke();
          } else if (paintTool === 'rect') {
            ctx.strokeRect(paintDraw.sx, paintDraw.sy, finalX - paintDraw.sx, finalY - paintDraw.sy);
          } else if (paintTool === 'fill-rect') {
            ctx.fillRect(paintDraw.sx, paintDraw.sy, finalX - paintDraw.sx, finalY - paintDraw.sy);
          } else if (paintTool === 'fill-ellipse') {
            const cx = (paintDraw.sx + finalX) / 2;
            const cy = (paintDraw.sy + finalY) / 2;
            const rx = Math.abs(finalX - paintDraw.sx) / 2;
            const ry = Math.abs(finalY - paintDraw.sy) / 2;
            ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
            ctx.fill();
          } else if (paintTool === 'arrow') {
            ctx.moveTo(paintDraw.sx, paintDraw.sy);
            ctx.lineTo(finalX, finalY);
            ctx.stroke();
            const angle = Math.atan2(finalY - paintDraw.sy, finalX - paintDraw.sx);
            const headLen = Math.max(paintSize * 4, 12);
            ctx.beginPath();
            ctx.moveTo(finalX, finalY);
            ctx.lineTo(finalX - headLen * Math.cos(angle - Math.PI/7), finalY - headLen * Math.sin(angle - Math.PI/7));
            ctx.moveTo(finalX, finalY);
            ctx.lineTo(finalX - headLen * Math.cos(angle + Math.PI/7), finalY - headLen * Math.sin(angle + Math.PI/7));
            ctx.stroke();
          }
          ctx.restore();
        }

        if (paintTool === 'fill-pen' && _fillPenPath.length >= 2) {
          const ctx = getPaintCtx();
          if (ctx) {
            if (_fillPenSnap) ctx.putImageData(_fillPenSnap, 0, 0);
            ctx.save();
            ctx.strokeStyle = paintColor;
            ctx.lineWidth   = paintSize;
            ctx.globalAlpha = paintOpacity;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(_fillPenPath[0].x, _fillPenPath[0].y);
            for (let i = 1; i < _fillPenPath.length; i++) {
              ctx.lineTo(_fillPenPath[i].x, _fillPenPath[i].y);
            }
            ctx.stroke();
            ctx.restore();
          }
        }
        let { x, y } = getPos(e, pc);
        _fillPenSnap  = null;
        _fillPenPath  = [];
        paintDraw.active = false;
        paintDraw.snap   = null;
        paintDraw.eraserMode = false;
        drawCursorOverlay(x, y, false);
      });
      
      panel.addEventListener('pointercancel', (e) => {
        if (!paintDraw.active) return;
        panel.releasePointerCapture(e.pointerId);
        paintDraw.active = false;
        const ctx = getPaintCtx();
        if (ctx && paintDraw.snap) ctx.putImageData(paintDraw.snap, 0, 0);
        _fillPenSnap  = null;
        _fillPenPath  = [];
        paintDraw.snap = null;
        paintDraw.eraserMode = false;
        hideCursorOverlay();
      });
    }

    // ペイントUI開閉
    paintBtn?.addEventListener('click', () => {
      if (!_items[_idx] || _pageLayout !== 'single' || _isScroll) {
        alert('ペイントは「単一表示」モード時のみ使用可能です。右上から単一表示[1]に切り替えてください。');
        return;
      }
      const isPainting = !paintUI.classList.contains('hidden');
      if (isPainting) {
        closeEditUIs();
        return;
      }
      
      closeEditUIs();
      paintBtn.classList.add('active');
      const renderPanel = g('viewer-render-panel');
      if (paintUI.parentElement !== renderPanel) renderPanel.appendChild(paintUI);
      paintUI.classList.remove('hidden');
      // ペイントキャンバスを同期・表示
      syncPaintCanvas();
      const pc = getPaintCanvas();
      if (pc) {
        pc.style.display = 'block';
        g('viewer-canvas').classList.add('paint-active');
        // カーソルオーバーレイを同期
        const cc = getPaintCursor();
        if (cc) { cc.style.display = 'none'; }
        syncCursorCanvas();
        // パネルのタッチスクロール無効化
        if (renderPanel) renderPanel.style.touchAction = 'none';
        // ペイントイベントの多重登録を防止
        if (!renderPanel._paintEventsBound) {
          setupPaintEvents();
          renderPanel._paintEventsBound = true;
        }
      }
    });

    // ツール選択
    const TOOL_HINTS = {
      'pen':          'なめらかな線を描画',
      'fill-pen':     '経路を塗りつぶし・ハイライトで可視化',
      'eraser':       '消しゴム（カーソルで範囲表示）',
      'line':         '直線 (Shiftキーで角度スナップ)',
      'rect':         '矩形・枠線のみ (Shiftキーで正方形)',
      'fill-rect':    '矩形をベタ塗り (Shiftキーで正方形)',
      'fill-ellipse': '楕円をベタ塗り (Shiftキーで正円)',
      'arrow':        '矢印 (Shiftキーで角度スナップ)',
      'text':         'クリック位置にテキスト配置',
      'stamp':        'クリック位置に定型スタンプ配置',
    };
    paintUI?.querySelectorAll('.paint-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        paintTool = btn.dataset.tool;
        paintUI.querySelectorAll('.paint-tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const textFg = g('paint-text-fg');
        if (textFg) textFg.classList.toggle('hidden', paintTool !== 'text');
        
        const stampFg = g('paint-stamp-fg');
        if (stampFg) stampFg.classList.toggle('hidden', paintTool !== 'stamp');

        const hint = g('paint-tool-hint');
        if (hint) hint.textContent = TOOL_HINTS[paintTool] || '';
      });
    });

    // カラー選択
    paintUI?.querySelectorAll('.paint-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        paintColor = btn.dataset.color;
        paintUI.querySelectorAll('.paint-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cust = g('paint-color-custom');
        if (cust) cust.value = paintColor;
      });
    });
    g('paint-color-custom')?.addEventListener('input', (e) => {
      paintColor = e.target.value;
      paintUI?.querySelectorAll('.paint-color-btn').forEach(b => b.classList.remove('active'));
    });

    // 太さ・不透明度
    g('paint-size')?.addEventListener('input', (e) => {
      paintSize = Number(e.target.value);
      const sv = g('paint-size-val');
      if (sv) sv.textContent = paintSize + 'px';
    });
    g('paint-opacity')?.addEventListener('input', (e) => {
      paintOpacity = Number(e.target.value) / 100;
      const ov = g('paint-opacity-val');
      if (ov) ov.textContent = e.target.value + '%';
    });

    // 操作ボタン
    g('paint-undo-btn')?.addEventListener('click', paintUndo);
    g('paint-clear-btn')?.addEventListener('click', paintClear);
    g('paint-apply-btn')?.addEventListener('click', paintApply);

    // クロップUIロジック
    const cropBtn = g('vhd-crop');
    const cropUI = g('viewer-crop-ui');
    const cropBox = g('crop-box');
    const cropApply = g('crop-apply');
    const cropCancel = g('crop-cancel');
    const bgs = {
      t: document.querySelector('.crop-overlay-bg.top'),
      b: document.querySelector('.crop-overlay-bg.bottom'),
      l: document.querySelector('.crop-overlay-bg.left'),
      r: document.querySelector('.crop-overlay-bg.right')
    };

    let cropRatio = 'free';

    const cropRatioSel = g('crop-ratio');
    if (cropRatioSel) {
      cropRatioSel.addEventListener('change', e => {
        cropRatio = e.target.value;
        if (cropRatio !== 'free' && cropUI && !cropUI.classList.contains('hidden')) {
          const r = parseFloat(cropRatio);
          const cw = parseFloat(cropUI.style.width);
          const ch = parseFloat(cropUI.style.height);
          let w = parseFloat(cropBox.style.width);
          let h = parseFloat(cropBox.style.height);
          let x = parseFloat(cropBox.style.left);
          let y = parseFloat(cropBox.style.top);
          
          if (w / h > r) { w = h * r; } else { h = w / r; }
          if (x + w > cw) w = cw - x;
          if (y + h > ch) h = ch - y;
          setCropRect(x, y, w, h, cw, ch);
        }
      });
    }

    cropBtn?.addEventListener('click', () => {
      if (!_items[_idx] || _pageLayout !== 'single' || _isScroll) {
        alert('クロップは「単一表示」モード時のみ使用可能です。右上から単一表示[1]に切り替えてください。');
        return;
      }

      const isCropping = !cropUI.classList.contains('hidden');
      if (isCropping) {
        closeEditUIs();
        return;
      }

      closeEditUIs();
      cropBtn.classList.add('active');

      const canvas = g('viewer-canvas');
      const cw = canvas.offsetWidth || parseFloat(canvas.style.width) || canvas.width;
      const ch = canvas.offsetHeight || parseFloat(canvas.style.height) || canvas.height;

      // offsetTop/Left は offsetParent (#viewer-page-wrap) 基準 → そのまま使用
      cropUI.style.top    = canvas.offsetTop  + 'px';
      cropUI.style.left   = canvas.offsetLeft + 'px';
      cropUI.style.width  = cw + 'px';
      cropUI.style.height = ch + 'px';
      cropUI.classList.remove('hidden');

      if (cropRatioSel) cropRatioSel.value = 'free';
      cropRatio = 'free';

      const curCrop = _items[_idx]?.cropBox;
      if (curCrop) {
        setCropRect(curCrop.x * cw, curCrop.y * ch, curCrop.width * cw, curCrop.height * ch, cw, ch);
      } else {
        setCropRect(cw * 0.1, ch * 0.1, cw * 0.8, ch * 0.8, cw, ch);
      }
    });

    function setCropRect(x, y, w, h, cw, ch) {
      cropBox.style.left = x + 'px'; cropBox.style.top = y + 'px';
      cropBox.style.width = w + 'px'; cropBox.style.height = h + 'px';
      bgs.t.style.left = '0'; bgs.t.style.top = '0'; bgs.t.style.width = '100%'; bgs.t.style.height = y + 'px';
      bgs.b.style.left = '0'; bgs.b.style.top = (y + h) + 'px'; bgs.b.style.width = '100%'; bgs.b.style.height = (ch - y - h) + 'px';
      bgs.l.style.left = '0'; bgs.l.style.top = y + 'px'; bgs.l.style.width = x + 'px'; bgs.l.style.height = h + 'px';
      bgs.r.style.left = (x + w) + 'px'; bgs.r.style.top = y + 'px'; bgs.r.style.width = (cw - x - w) + 'px'; bgs.r.style.height = h + 'px';

      // ツールバー位置を適応的に調整（上端余白不足時は下に、左右はみ出しをクランプ）
      const toolbar = cropBox.querySelector('.crop-toolbar');
      if (toolbar) {
        const toolbarH = 44;
        if (y < toolbarH + 10) {
          toolbar.style.top    = (h + 8) + 'px';
        } else {
          toolbar.style.top    = (-toolbarH) + 'px';
        }
        toolbar.style.bottom    = '';
        toolbar.style.left      = '50%';
        toolbar.style.transform = 'translateX(-50%)';

        // 水平方向のはみ出しを RAF で確認してクランプ
        requestAnimationFrame(() => {
          if (!toolbar.isConnected) return;
          const tbW = toolbar.offsetWidth;
          if (!tbW) return;
          // cropBox座標系でのデフォルト left
          let tbLeft = w / 2 - tbW / 2;
          // cropUI座標系での絶対位置
          const absLeft  = x + tbLeft;
          const absRight = absLeft + tbW;
          if (absLeft < 6) {
            tbLeft = 6 - x;
          } else if (absRight > cw - 6) {
            tbLeft = cw - 6 - tbW - x;
          }
          toolbar.style.left      = tbLeft + 'px';
          toolbar.style.transform = 'none';
        });
      }
    }

    let dragInfo = null;
    cropBox?.addEventListener('mousedown', e => {
      // ツールバー（cropBox内部）でのクリックはドラッグ開始しない
      if (e.target.closest('.crop-toolbar')) return;
      dragInfo = {
        startX: e.clientX, startY: e.clientY,
        initX: parseFloat(cropBox.style.left), initY: parseFloat(cropBox.style.top),
        initW: parseFloat(cropBox.style.width), initH: parseFloat(cropBox.style.height),
        handle: e.target.classList.contains('crop-handle') ? e.target.className.split(' ')[1] : 'move',
        cw: parseFloat(cropUI.style.width), ch: parseFloat(cropUI.style.height)
      };
      e.stopPropagation(); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragInfo) return;
      const dx = e.clientX - dragInfo.startX, dy = e.clientY - dragInfo.startY;
      let { initX: x, initY: y, initW: w, initH: h, handle, cw, ch } = dragInfo;
      
      if (handle === 'move') { 
        x += dx; y += dy; 
      } else {
        if (cropRatio !== 'free') {
          const r = parseFloat(cropRatio);
          let newW = w, newH = h;
          if (handle.includes('e')) newW = w + dx;
          else if (handle.includes('w')) newW = w - dx;
          else if (handle.includes('n')) newH = h - dy;
          else if (handle.includes('s')) newH = h + dy;
          
          if (handle.includes('e') || handle.includes('w')) {
            newH = newW / r;
          } else {
            newW = newH * r;
          }

          if (newW < 20) { newW = 20; newH = newW / r; }
          if (newH < 20) { newH = 20; newW = newH * r; }

          if (handle.includes('w')) x = dragInfo.initX + dragInfo.initW - newW;
          if (handle.includes('n')) y = dragInfo.initY + dragInfo.initH - newH;

          if (handle === 'n' || handle === 's') x = dragInfo.initX + (dragInfo.initW - newW) / 2;
          if (handle === 'e' || handle === 'w') y = dragInfo.initY + (dragInfo.initH - newH) / 2;

          w = newW; h = newH;
        } else {
          if (handle.includes('e')) w += dx;
          if (handle.includes('w')) { x += dx; w -= dx; }
          if (handle.includes('s')) h += dy;
          if (handle.includes('n')) { y += dy; h -= dy; }
        }
      }

      if (w < 20) { w = 20; if(cropRatio !== 'free') h = w / parseFloat(cropRatio); }
      if (h < 20) { h = 20; if(cropRatio !== 'free') w = h * parseFloat(cropRatio); }
      
      if (x < 0) {
        x = 0; 
        if (handle !== 'move' && cropRatio !== 'free') { w = dragInfo.initX + dragInfo.initW; h = w / parseFloat(cropRatio); }
      }
      if (y < 0) {
        y = 0; 
        if (handle !== 'move' && cropRatio !== 'free') { h = dragInfo.initY + dragInfo.initH; w = h * parseFloat(cropRatio); }
      }
      if (x + w > cw) {
        if (handle === 'move') x = cw - w; 
        else { w = cw - x; if (cropRatio !== 'free') h = w / parseFloat(cropRatio); }
      }
      if (y + h > ch) {
        if (handle === 'move') y = ch - h; 
        else { h = ch - y; if (cropRatio !== 'free') w = h * parseFloat(cropRatio); }
      }
      
      setCropRect(x, y, w, h, cw, ch);
    });
    document.addEventListener('mouseup', () => { dragInfo = null; });

    cropCancel?.addEventListener('click', () => {
      closeEditUIs();
    });
    const cropResetBtn = g('crop-reset');
    cropResetBtn?.addEventListener('click', () => {
      if (cropRatioSel) cropRatioSel.value = 'free';
      cropRatio = 'free';
      const item = _items[_idx];
      if (item) {
        item.cropBox = null;
        item.thumbnail = null;
        thumbQ(() => genThumb(item));
        saveState();
        render(); // 再描画によりバッジも消去
      }
      closeEditUIs();
    });
    cropApply?.addEventListener('click', async () => {
      closeEditUIs();
      const item = _items[_idx];
      if (item) {
        const cw = parseFloat(cropUI.style.width), ch = parseFloat(cropUI.style.height);
        const cx = parseFloat(cropBox.style.left) / cw;
        const cy = parseFloat(cropBox.style.top) / ch;
        const cWidth = parseFloat(cropBox.style.width) / cw;
        const cHeight = parseFloat(cropBox.style.height) / ch;
        
        if (cx <= 0.01 && cy <= 0.01 && cWidth >= 0.99 && cHeight >= 0.99) {
          item.cropBox = null;
        } else {
          item.cropBox = { x: cx, y: cy, width: cWidth, height: cHeight };
        }
        
        const ld = g('viewer-ld');
        if (ld) ld.style.display = 'flex';
        
        await commitItemEdits(item);
        
        saveState('クロップの適用');
        thumbQ(() => genThumb(item)).then(() => {
          if (_items[_idx]?.id === item.id) render();
        });
      }
    });

    // ── クロップUI背景でのドラッグ描画（新規矩形を引く） ──────────────
    cropUI?.addEventListener('mousedown', e => {
      // cropBox やツールバー上は既存ハンドラに委任
      if (cropBox.contains(e.target)) return;
      if (dragInfo) return;

      const rect = cropUI.getBoundingClientRect();
      const cw   = parseFloat(cropUI.style.width)  || cropUI.offsetWidth;
      const ch   = parseFloat(cropUI.style.height) || cropUI.offsetHeight;
      const ix   = Math.max(0, Math.min(e.clientX - rect.left, cw - 2));
      const iy   = Math.max(0, Math.min(e.clientY - rect.top,  ch - 2));

      // 幅・高さ 1px の矩形を起点として se ハンドルで拡大（既存 mousemove ロジックを再利用）
      setCropRect(ix, iy, 1, 1, cw, ch);
      dragInfo = {
        startX: e.clientX, startY: e.clientY,
        initX: ix, initY: iy,
        initW: 1, initH: 1,
        handle: 'se',
        cw, ch,
        isDrawing: true,
      };
      e.preventDefault();
      e.stopPropagation();
    });

    g('viewer-mojibake-btn')?.addEventListener('click', () => {
      if (!_items[_idx]) return;
      const cached = _textCache.get(_items[_idx].id);
      if (!cached || cached.source !== 'text') return;
      const enc = g('viewer-mojibake-enc').value;
      const fixed = fixMojibake(cached.originalText || cached.text, enc);
      cached.text = fixed; 
      g('viewer-text-area').value = fixed;
      const btn = g('viewer-mojibake-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>適用済';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    });

    g('vtab-render').addEventListener('click', () => switchTab('render'));
    g('vtab-text').addEventListener('click',   () => switchTab('text'));
    g('vtab-3d')?.addEventListener('click',    () => switchTab('3d'));

    // 3Dビューア操作ボタン
    g('v3d-wireframe')?.addEventListener('click', function() {
      const on = ThreeViewer.toggleWireframe();
      this.classList.toggle('active', on);
    });
    g('v3d-grid')?.addEventListener('click', function() {
      const on = ThreeViewer.toggleGrid();
      this.classList.toggle('active', on);
    });
    g('v3d-reset')?.addEventListener('click', () => ThreeViewer.resetCamera());

    g('viewer-text-copy-btn').addEventListener('click', async () => {
      const ta = g('viewer-text-area');
      if (!ta?.value) return;
      try { await navigator.clipboard.writeText(ta.value); } 
      catch { ta.select(); document.execCommand('copy'); }
      const btn = g('viewer-text-copy-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>コピー完了';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    });

    g('viewer-text-save-btn')?.addEventListener('click', () => {
      const ta = g('viewer-text-area');
      const item = _items[_idx];
      if (!ta || !item) return;
      
      const newText = ta.value;
      item.textContent = newText;
      
      if (_textCache.has(item.id)) {
        const cached = _textCache.get(item.id);
        cached.text = newText;
      } else {
        _textCache.set(item.id, { text: newText, source: 'text', originalText: newText });
      }
      
      saveState();

      const btn = g('viewer-text-save-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>保存完了';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    });

    const wrap = g('viewer-canvas-wrap');
    if (wrap && typeof ResizeObserver !== 'undefined') {
      _resizeObs = new ResizeObserver(() => {
        if (!_open) return;
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => { 
          if (_open && _items.length > 0) {
            closeEditUIs();
            render(); 
          }
        }, 180);
      });
      _resizeObs.observe(wrap);
    }

    // QR結果モーダルイベント
    g('qr-close')?.addEventListener('click', () => g('qr-overlay').classList.add('hidden'));
    g('qr-copy-btn')?.addEventListener('click', async () => {
      const text = g('qr-result-text')?.value;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        g('qr-result-text').select();
        document.execCommand('copy');
      }
      const btn = g('qr-copy-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>完了';
      setTimeout(() => btn.innerHTML = orig, 2000);
    });

    // パネルのドラッグ移動 (画像調整, ペイント, スキャン補正)
    makeDraggable('viewer-adjust-ui', '.adj-header');
    makeDraggable('viewer-paint-ui', '.adj-header');
    makeDraggable('viewer-scanfix-ui', '.adj-header');

    // ── スキャン補正 (ScanFix) ロジック ────────────────────────────────
    const sfBtn = g('vhd-scanfix');
    const sfUI = g('viewer-scanfix-ui');
    const sfOverlay = g('viewer-scanfix-overlay');
    const sfCanvas = g('sf-canvas');
    const sfPoly = g('sf-poly');
    const sfHandles = document.querySelectorAll('.sf-handle');
    const sfRotSlider = g('sf-rot');
    const sfValRot = g('sf-val-rot');
    
    let sfBaseImage = null; // 回転0度の元の画像(オフスクリーン)
    let sfPts = [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}]; // 4頂点 {x,y} 相対座標(0-1)
    let sfRot = 0;
    // 通常ビューアの CSS 表示サイズを記録し、編集モードでも同じ表示サイズを維持する
    let sfViewerW = 0, sfViewerH = 0;
    
    const updateSfPoly = () => {
      if (!sfCanvas) return;
      const cw = sfCanvas.offsetWidth;
      const ch = sfCanvas.offsetHeight;
      const left = sfCanvas.offsetLeft;
      const top = sfCanvas.offsetTop;
      
      let pointsStr = '';
      sfPts.forEach((p, i) => {
        const px = left + p.x * cw;
        const py = top + p.y * ch;
        pointsStr += `${px},${py} `;
        if (sfHandles[i]) {
          sfHandles[i].style.left = px + 'px';
          sfHandles[i].style.top = py + 'px';
        }
      });
      sfPoly.setAttribute('points', pointsStr.trim());
    };

    const drawSfCanvas = () => {
      if (!sfBaseImage || !sfCanvas) return;
      const ctx = sfCanvas.getContext('2d');
      const rad = sfRot * Math.PI / 180;
      const w = sfBaseImage.width;
      const h = sfBaseImage.height;
      
      sfCanvas.width = w;
      sfCanvas.height = h;
      
      // ── 通常プレビューと同一の CSS 表示サイズを使用する ──
      // sfViewerW/H は viewer-canvas を非表示にする直前に記録した値。
      // これにより、編集モード突入時にページが大きくなる認知的違和感を排除する。
      // 未記録時（再描画等）のみパネルサイズから計算するフォールバック。
      if (sfViewerW > 0 && sfViewerH > 0) {
        sfCanvas.style.width  = sfViewerW + 'px';
        sfCanvas.style.height = sfViewerH + 'px';
      } else {
        const panel = g('viewer-render-panel');
        const maxW = (panel.clientWidth  || 800) - 100;
        const maxH = (panel.clientHeight || 600) - 100;
        const sc = Math.min(maxW / w, maxH / h);
        sfCanvas.style.width  = (w * sc) + 'px';
        sfCanvas.style.height = (h * sc) + 'px';
      }
      
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rad);
      ctx.drawImage(sfBaseImage, -w / 2, -h / 2);
      ctx.restore();
      
      updateSfPoly();
    };

    const autoDetectAngle = (canvas) => {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const sampleScale = Math.min(1, 400 / Math.max(w, h));
      const sw = Math.round(w * sampleScale), sh = Math.round(h * sampleScale);
      
      const scCnv = document.createElement('canvas');
      scCnv.width = sw; scCnv.height = sh;
      const sCtx = scCnv.getContext('2d');
      sCtx.drawImage(canvas, 0, 0, sw, sh);
      
      const imgData = sCtx.getImageData(0, 0, sw, sh);
      const data = imgData.data;
      
      const gray = new Uint8Array(sw * sh);
      for(let i=0; i<data.length; i+=4) {
        gray[i/4] = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
      }
      
      const bins = new Int32Array(1800);
      for(let y=1; y<sh-1; y++) {
        for(let x=1; x<sw-1; x++) {
          const idx = y*sw + x;
          const gx = -gray[idx-sw-1] + gray[idx-sw+1]
                     -2*gray[idx-1]   + 2*gray[idx+1]
                     -gray[idx+sw-1] + gray[idx+sw+1];
          const gy = -gray[idx-sw-1] - 2*gray[idx-sw] - gray[idx-sw+1]
                     +gray[idx+sw-1] + 2*gray[idx+sw] + gray[idx+sw+1];
          
          const mag = Math.abs(gx) + Math.abs(gy);
          if (mag > 100) {
            let angle = Math.atan2(gy, gx) * 180 / Math.PI;
            let skew = angle > 0 ? angle - 90 : angle + 90;
            if (skew > 45) skew -= 90;
            if (skew < -45) skew += 90;
            
            if (skew >= -45 && skew <= 45) {
              const binIdx = Math.floor((skew + 45) * 20);
              if(binIdx >= 0 && binIdx < bins.length) bins[binIdx] += mag;
            }
          }
        }
      }
      
      let maxBin = -1, maxVal = -1;
      for(let i=0; i<bins.length; i++) {
        const val = (bins[i-1]||0) + bins[i] + (bins[i+1]||0);
        if(val > maxVal) { maxVal = val; maxBin = i; }
      }
      if(maxBin >= 0) return (maxBin / 20) - 45;
      return 0;
    };

    // ── 傾き検出結果を視覚的にパネルへ反映 ──
    // detected: 文書の検出傾き(°)  correction: スライダーに設定した補正量(°)
    const updateSfDetectPanel = (detected, correction) => {
      const sign = v => v > 0 ? '+' : '';
      const rawEl  = g('sf-raw-angle');
      const corrEl = g('sf-corr-angle');
      const dirEl  = g('sf-detect-dir');
      if (rawEl)  rawEl.textContent  = sign(detected)   + detected.toFixed(2)   + '°';
      if (corrEl) corrEl.textContent = sign(correction) + correction.toFixed(2) + '°';

      if (dirEl) {
        if (Math.abs(detected) < 0.05) {
          dirEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> 傾きなし — 補正不要';
          dirEl.className = 'sf-detect-dir no-tilt';
        } else {
          const cwStr  = detected > 0 ? '時計回り' : '反時計回り';
          const fixIcon = correction > 0 ? 'fa-rotate-right' : 'fa-rotate-left';
          const fixStr  = correction > 0 ? '右(時計回り)に補正' : '左(反時計回り)に補正';
          dirEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
            文書が<strong>${cwStr}</strong>に傾き →
            <i class="fa-solid ${fixIcon}"></i>${fixStr}`;
          dirEl.className = 'sf-detect-dir';
        }
      }

      // ── Canvas ビジュアライザー ──
      const cnv = g('sf-tilt-canvas');
      if (!cnv) return;
      const ctx = cnv.getContext('2d');
      const W = cnv.width, H = cnv.height;
      ctx.clearRect(0, 0, W, H);

      // 背景
      ctx.fillStyle = '#1e1b4b';
      ctx.fillRect(0, 0, W, H);

      // roundRect ポリフィル（グレースフル・デグラデーション）
      const rRect = (c, x, y, w, h, r) => {
        if (typeof c.roundRect === 'function') { c.roundRect(x, y, w, h, r); return; }
        c.moveTo(x+r, y); c.lineTo(x+w-r, y); c.quadraticCurveTo(x+w, y, x+w, y+r);
        c.lineTo(x+w, y+h-r); c.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
        c.lineTo(x+r, y+h); c.quadraticCurveTo(x, y+h, x, y+h-r);
        c.lineTo(x, y+r); c.quadraticCurveTo(x, y, x+r, y); c.closePath();
      };

      // ミニ文書アイコン描画
      const drawDoc = (cx, cy, angleDeg, color) => {
        const dw = 28, dh = 36, fold = 7;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angleDeg * Math.PI / 180);
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
        ctx.fillStyle = color;
        ctx.beginPath(); rRect(ctx, -dw/2, -dh/2, dw, dh, 2); ctx.fill();
        ctx.shadowBlur = 0;
        // 折り角
        ctx.fillStyle = 'rgba(0,0,0,.2)';
        ctx.beginPath();
        ctx.moveTo(dw/2-fold, -dh/2); ctx.lineTo(dw/2, -dh/2+fold);
        ctx.lineTo(dw/2-fold, -dh/2+fold); ctx.closePath(); ctx.fill();
        // テキスト線
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        for (let i=0; i<3; i++) ctx.fillRect(-dw/2+4, -4+i*7, dw-8-(i===2?8:0), 2);
        ctx.restore();
      };

      const lx = 50, rx = W - 50, mx = W / 2;

      // 左：傾いた文書（検出状態）
      const severity = Math.min(Math.abs(detected) / 10, 1);
      const beforeColor = Math.abs(detected) < 0.05 ? '#22c55e'
        : `hsl(${38 - severity*38}, 90%, 62%)`;
      drawDoc(lx, H/2, detected, beforeColor);

      // 右：補正後（水平）
      drawDoc(rx, H/2, 0, '#34d399');

      // 中央：補正方向アーク矢印
      if (Math.abs(detected) >= 0.05) {
        const arcR = 16;
        const arcStart = detected * Math.PI / 180 - Math.PI/2;
        const arcEnd   = -Math.PI / 2;
        const ccw = detected > 0;
        ctx.save();
        ctx.strokeStyle = '#818cf8'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx, H/2, arcR, arcStart, arcEnd, ccw); ctx.stroke();
        // 矢印先端
        const tx = mx + arcR * Math.cos(arcEnd);
        const ty = H/2 + arcR * Math.sin(arcEnd);
        const tipA = arcEnd + (ccw ? -0.3 : 0.3);
        const hl = 5;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - hl*Math.cos(tipA-Math.PI/6), ty - hl*Math.sin(tipA-Math.PI/6));
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - hl*Math.cos(tipA+Math.PI/6), ty - hl*Math.sin(tipA+Math.PI/6));
        ctx.stroke();
        ctx.restore();
      }

      // 水平基準線（点線）
      const dline = (x1, x2, y, col) => {
        ctx.save(); ctx.setLineDash([2,3]); ctx.strokeStyle = col;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke(); ctx.restore();
      };
      dline(lx-22, lx+22, H/2, 'rgba(148,163,184,.35)');
      dline(rx-22, rx+22, H/2, 'rgba(52,211,153,.4)');

      // ラベル
      ctx.font = '8px sans-serif'; ctx.fillStyle = 'rgba(148,163,184,.6)'; ctx.textAlign = 'center';
      ctx.fillText('検出', lx, 10); ctx.fillText('補正後', rx, 10);
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = Math.abs(detected)<0.05 ? '#22c55e' : '#f59e0b';
      ctx.fillText((detected>0?'+':'') + detected.toFixed(1)+'°', lx, H-5);
      ctx.fillStyle = '#34d399';
      ctx.fillText('±0.0°', rx, H-5);
      if (Math.abs(detected) >= 0.05) {
        ctx.fillStyle = '#818cf8'; ctx.font = 'bold 8px monospace';
        ctx.fillText('補正', mx, H-5);
      }
    };

    sfRotSlider?.addEventListener('input', e => {
      sfRot = parseFloat(e.target.value);
      if (sfValRot) sfValRot.textContent = sfRot.toFixed(1) + '°';
      drawSfCanvas();
    });
    
    g('sf-auto-angle')?.addEventListener('click', () => {
      if (!sfBaseImage) return;
      const btn = g('sf-auto-angle');
      const detectPanel = g('sf-detect-panel');
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>解析中...</span>';
      setTimeout(() => {
        const detected = autoDetectAngle(sfBaseImage);

        // ── 符号修正: 傾きを打ち消すには逆符号で回転させる ──
        // detected = 文書の傾き量。例: +3° 傾いているなら sfRot = -3° で補正。
        sfRot = -detected;

        if (sfRotSlider) sfRotSlider.value = sfRot;
        if (sfValRot) sfValRot.textContent = sfRot.toFixed(1) + '°';
        drawSfCanvas();

        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check"></i><span>検出完了</span>';
        setTimeout(() => {
          btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>自動傾き検出</span>';
        }, 2000);

        // 検出結果パネルを更新・表示
        updateSfDetectPanel(detected, sfRot);
        if (detectPanel) detectPanel.classList.remove('hidden');
      }, 50);
    });

    let sfDragInfo = null;
    sfHandles.forEach(h => {
      h.addEventListener('mousedown', e => {
        sfDragInfo = { idx: parseInt(h.dataset.idx, 10) };
        e.stopPropagation(); e.preventDefault();
      });
    });
    document.addEventListener('mousemove', e => {
      if (!sfDragInfo || !sfOverlay || sfOverlay.classList.contains('hidden')) return;
      const rect = sfOverlay.getBoundingClientRect();
      const cw = sfCanvas.offsetWidth;
      const ch = sfCanvas.offsetHeight;
      const cleft = sfCanvas.offsetLeft;
      const ctop = sfCanvas.offsetTop;
      
      let nx = e.clientX - rect.left - cleft;
      let ny = e.clientY - rect.top - ctop;
      
      nx = Math.max(0, Math.min(nx, cw));
      ny = Math.max(0, Math.min(ny, ch));
      
      sfPts[sfDragInfo.idx].x = nx / cw;
      sfPts[sfDragInfo.idx].y = ny / ch;
      updateSfPoly();
    });
    document.addEventListener('mouseup', () => { sfDragInfo = null; });

    sfBtn?.addEventListener('click', async () => {
      if (!_items[_idx] || _pageLayout !== 'single' || _isScroll) {
        alert('スキャン補正は「単一表示」モード時のみ使用可能です。右上から単一表示[1]に切り替えてください。');
        return;
      }
      if (!sfUI.classList.contains('hidden')) {
        closeEditUIs(); return;
      }
      closeEditUIs();
      sfBtn.classList.add('active');
      
      const item = _items[_idx];
      const jsDoc = S.jsDocs.get(item.fileId);
      if (!jsDoc) return;
      
      const ld = g('viewer-ld');
      ld.style.display = 'flex';
      
      try {
        const page = await jsDoc.getPage(item.pageIndex + 1);
        const totalRot = (page.rotate + item.rotation) % 360;
        
        const c = document.createElement('canvas');
        
        if (item.scanFixData) {
          const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
          const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
          const w = (item.rotation === 90 || item.rotation === 270) ? lh : lw;
          const h = (item.rotation === 90 || item.rotation === 270) ? lw : lh;
          c.width = Math.round(w * 2.0);
          c.height = Math.round(h * 2.0);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);

          const img = new Image();
          img.src = item.scanFixData.dataUrl;
          await new Promise(r => { img.onload = r; });
          
          ctx.save();
          ctx.translate(c.width / 2, c.height / 2);
          ctx.rotate(item.rotation * Math.PI / 180);
          const _elw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
          const _elh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
          ctx.drawImage(img, -_elw * 2.0 / 2, -_elh * 2.0 / 2, _elw * 2.0, _elh * 2.0);
          ctx.restore();
        } else {
          const vp = page.getViewport({ scale: 2.0, rotation: totalRot });
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
        }

        // 現在のプレビュー状態（反転）をスキャン補正のソース画像に焼き込む
        applyFlipToCanvas(c, item);

        sfBaseImage = c;
        sfRot = 0;
        if (sfRotSlider) sfRotSlider.value = 0;
        if (sfValRot) sfValRot.textContent = '0.0°';
        
        // 検出パネルをリセット
        const dp = g('sf-detect-panel');
        if (dp) dp.classList.add('hidden');
        const autoBtn = g('sf-auto-angle');
        if (autoBtn) autoBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>自動傾き検出</span>';

        sfPts = [
          {x: 0, y: 0}, {x: 1, y: 0},
          {x: 1, y: 1}, {x: 0, y: 1}
        ];
        
        // ── viewer-canvas の CSS 表示サイズを記録する（display:none にする前に必ず取得）──
        // offsetWidth は非表示後に 0 になるため、このタイミングが唯一の取得機会。
        // drawSfCanvas でこのサイズを使うことで通常プレビューとの表示サイズを一致させる。
        const _vc = g('viewer-canvas');
        sfViewerW = _vc.offsetWidth  || parseFloat(_vc.style.width)  || _vc.width || 0;
        sfViewerH = _vc.offsetHeight || parseFloat(_vc.style.height) || _vc.height || 0;
        _vc.style.display = 'none';
        sfUI.classList.remove('hidden');
        sfOverlay.classList.remove('hidden');
        drawSfCanvas();
        
      } catch (err) {
        console.error(err);
        alert('画像の読み込みに失敗しました');
      } finally {
        ld.style.display = 'none';
      }
    });

    g('sf-cancel')?.addEventListener('click', () => {
      closeEditUIs();
    });

    g('sf-reset')?.addEventListener('click', () => {
      sfRot = 0;
      if (sfRotSlider) sfRotSlider.value = 0;
      if (sfValRot) sfValRot.textContent = '0.0°';
      sfPts = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}];
      const dp = g('sf-detect-panel');
      if (dp) dp.classList.add('hidden');
      const autoBtn = g('sf-auto-angle');
      if (autoBtn) autoBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>自動傾き検出</span>';
      drawSfCanvas();
    });

    g('sf-apply')?.addEventListener('click', () => {
      if (!sfBaseImage) return;
      const ld = g('viewer-ld');
      ld.style.display = 'flex';
      
      setTimeout(() => {
        try {
          function getPerspectiveTransform(src, dst) {
            const a = [];
            for (let i = 0; i < 4; i++) {
              a.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x, dst[i].x]);
              a.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y, dst[i].y]);
            }
            for (let i = 0; i < 8; i++) {
              let pivot = i;
              for (let j = i + 1; j < 8; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
              const tmp = a[i]; a[i] = a[pivot]; a[pivot] = tmp;
              const div = a[i][i];
              for (let j = 0; j < 9; j++) a[i][j] /= div;
              for (let j = 0; j < 8; j++) {
                if (i !== j) {
                  const mul = a[j][i];
                  for (let k = 0; k < 9; k++) a[j][k] -= a[i][k] * mul;
                }
              }
            }
            return [a[0][8], a[1][8], a[2][8], a[3][8], a[4][8], a[5][8], a[6][8], a[7][8], 1];
          }

          function warpPerspective(srcImageData, dstWidth, dstHeight, m) {
            const dstImageData = new ImageData(dstWidth, dstHeight);
            const src = srcImageData.data;
            const dst = dstImageData.data;
            const sw = srcImageData.width;
            const sh = srcImageData.height;
            let dstIdx = 0;
            for (let y = 0; y < dstHeight; y++) {
              for (let x = 0; x < dstWidth; x++) {
                const w = m[6] * x + m[7] * y + m[8];
                const sx = (m[0] * x + m[1] * y + m[2]) / w;
                const sy = (m[3] * x + m[4] * y + m[5]) / w;
                const px = Math.floor(sx);
                const py = Math.floor(sy);
                if (px >= 0 && px < sw - 1 && py >= 0 && py < sh - 1) {
                  const fx = sx - px, fy = sy - py;
                  const fx1 = 1 - fx, fy1 = 1 - fy;
                  const w1 = fx1 * fy1, w2 = fx * fy1, w3 = fx1 * fy, w4 = fx * fy;
                  const i1 = (py * sw + px) * 4;
                  const i2 = i1 + 4;
                  const i3 = ((py + 1) * sw + px) * 4;
                  const i4 = i3 + 4;
                  for (let c = 0; c < 4; c++) {
                    dst[dstIdx + c] = src[i1 + c] * w1 + src[i2 + c] * w2 + src[i3 + c] * w3 + src[i4 + c] * w4;
                  }
                }
                dstIdx += 4;
              }
            }
            return dstImageData;
          }

          // sfPts は sfCanvas CSS空間(0-1正規化)で定義されている。
          // sfCanvas は sfBaseImage を sfRot 度回転させた中間バッファ。
          // sfCanvas → warpPerspective と2段階処理すると二重リサンプリングが発生し
          // プレビューより画質が劣化する原因となる。
          // 修正：sfPts を sfBaseImage ピクセル座標へ逆回転変換し、
          // sfBaseImage を直接ソースとして1回の warpPerspective に通す（単一補間）。
          const _sfRad = sfRot * Math.PI / 180;
          const _bw   = sfBaseImage.width;
          const _bh   = sfBaseImage.height;
          const _cwSf = sfCanvas.width;
          const _chSf = sfCanvas.height;

          // sfCanvas CSS空間(0-1) → sfCanvas ピクセル → sfBaseImage ピクセル（逆回転）
          function sfPtToBase(sfPt) {
            const cx = sfPt.x * _cwSf;
            const cy = sfPt.y * _chSf;
            const dx = cx - _cwSf / 2;
            const dy = cy - _chSf / 2;
            return {
              x: _bw / 2 + dx * Math.cos(_sfRad) + dy * Math.sin(_sfRad),
              y: _bh / 2 - dx * Math.sin(_sfRad) + dy * Math.cos(_sfRad)
            };
          }

          const p0 = sfPtToBase(sfPts[0]);
          const p1 = sfPtToBase(sfPts[1]);
          const p2 = sfPtToBase(sfPts[2]);
          const p3 = sfPtToBase(sfPts[3]);

          // sfBaseImage から直接読み取り（回転前の元データ、単一補間）
          const srcData = sfBaseImage.getContext('2d').getImageData(0, 0, _bw, _bh);

          const w1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          const w2 = Math.hypot(p2.x - p3.x, p2.y - p3.y);
          const h1 = Math.hypot(p3.x - p0.x, p3.y - p0.y);
          const h2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          
          let dstW = Math.max(Math.round((w1 + w2) / 2), 10);
          let dstH = Math.max(Math.round((h1 + h2) / 2), 10);
          
          const ratioSel = document.getElementById('sf-ratio');
          if (ratioSel && ratioSel.value !== 'free') {
            const r = parseFloat(ratioSel.value);
            // 縦長(1.4141)の場合は dstW を基準に dstH を決定、横長(0.7071)の場合は dstW を広げる
            if (r > 1) {
              dstH = Math.round(dstW * r);
            } else {
              dstW = Math.round(dstH / r);
            }
          }
          
          const srcPts = [p0, p1, p2, p3];
          const dstPts = [{x: 0, y: 0}, {x: dstW, y: 0}, {x: dstW, y: dstH}, {x: 0, y: dstH}];
          
          const invM = getPerspectiveTransform(dstPts, srcPts);
          const dstData = warpPerspective(srcData, dstW, dstH, invM);
          
          const outCnv = document.createElement('canvas');
          outCnv.width = dstW;
          outCnv.height = dstH;
          const outCtx = outCnv.getContext('2d');
          
          const bgColorSel = document.getElementById('sf-bg-color');
          const bgColor = bgColorSel ? bgColorSel.value : 'white';
          
          if (bgColor === 'white' || bgColor === 'black') {
            outCtx.fillStyle = bgColor;
            outCtx.fillRect(0, 0, dstW, dstH);
          }
          
          const tmpCnv = document.createElement('canvas');
          tmpCnv.width = dstW;
          tmpCnv.height = dstH;
          tmpCnv.getContext('2d').putImageData(dstData, 0, 0);
          
          outCtx.drawImage(tmpCnv, 0, 0);
          
          const mimeType = (bgColor === 'transparent') ? 'image/png' : 'image/jpeg';
          const quality = (bgColor === 'transparent') ? undefined : 0.95;
          
          const item = _items[_idx];
          const _sfLogW = dstW / 2.0;
          const _sfLogH = dstH / 2.0;
          item.scanFixData = {
            dataUrl: outCnv.toDataURL(mimeType, quality),
            width:         dstW,
            height:        dstH,
            logicalWidth:  _sfLogW,   // 論理サイズ (= ピクセル÷2): エクスポート・表示スケール計算の基準
            logicalHeight: _sfLogH
          };
          
          // 補正後の画像をベースにするため、PDFの回転やクロップ、サイズ情報を上書きリセットする
          // 反転はソース画像に焼き込み済みのためここでリセット
          item.rotation = 0;
          item.pageRotate = 0;
          item.flipH = false;
          item.flipV = false;
          item.cropBox = null;
          item.naturalPw = _sfLogW;
          item.naturalPh = _sfLogH;
          item.pw = _sfLogW;
          item.ph = _sfLogH;
          
          item.thumbnail = null;
          saveState('スキャン補正の適用');
          closeEditUIs();

          // genThumb完了後にビューアを再レンダリングすることで
          // pw/phが正しく反映された状態でビューアを表示する（適用直後の歪み防止）
          const _appliedId = item.id;
          thumbQ(() => genThumb(item)).then(() => {
            if (_items[_idx]?.id === _appliedId) render();
          });
          
        } catch (err) {
          console.error(err);
          alert('補正処理に失敗しました');
        } finally {
          ld.style.display = 'none';
        }
      }, 50);
    });
  }

  function decodeQR() {
    if (typeof jsQR === 'undefined') {
      alert('QRコードデコーダーが読み込めませんでした。');
      return;
    }
    const canvas = g('viewer-canvas');
    if (!canvas || canvas.width === 0) {
      alert('画像データが取得できません。');
      return;
    }
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });

    if (code && code.data) {
      const text = code.data;
      g('qr-result-text').value = text;
      const linkWrap = g('qr-action-wrap');
      const linkBtn = g('qr-link-btn');
      if (/^https?:\/\//.test(text)) {
        linkWrap.style.display = 'flex';
        linkBtn.href = text;
      } else {
        linkWrap.style.display = 'none';
      }
      g('qr-overlay').classList.remove('hidden');
    } else {
      alert('QRコードが検出されませんでした。ページ内に明確なQRコードが写っているか確認してください。');
    }
  }

  function makeDraggable(panelId, headerSelector) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const header = panel.querySelector(headerSelector);
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = panel.offsetLeft;
      initialTop = panel.offsetTop;
      panel.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let newLeft = initialLeft + (e.clientX - startX);
      let newTop = initialTop + (e.clientY - startY);
      const parent = panel.parentElement;
      if (parent) {
        const maxLeft = parent.clientWidth - panel.offsetWidth;
        const maxTop = parent.clientHeight - panel.offsetHeight;
        if (newLeft < 0) newLeft = 0;
        if (newTop < 0) newTop = 0;
        if (newLeft > maxLeft) newLeft = maxLeft;
        if (newTop > maxTop) newTop = maxTop;
      }
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
      panel.style.right = 'auto'; // 初回のみrightを解除
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        panel.style.transition = '';
      }
    });
  }

  // スクロールオブザーバー初期化
  function initScrollObserver() {
    if (_scrollObserver) {
      _scrollObserver.disconnect();
      _scrollObserver = null;
    }
    _scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const div = entry.target;
          const idx = parseInt(div.dataset.idx, 10);
          if (!div.dataset.rendered) {
            div.dataset.rendered = "true";
            renderScrollItem(div, idx);
          }
          // スクロール時に現在のページ番号を更新
          _idx = idx;
          _currentId = _items[_idx].id;
          updateHeader();
        }
      });
    }, { root: g('viewer-render-panel'), rootMargin: '300px 0px' });
  }

  // DOM初期化（単一/見開きモード と スクロールモードの切り替え）
  function initRenderPanelDOM() {
    const wrap = g('viewer-page-wrap');
    const panel = g('viewer-render-panel');
    const prev = g('vnav-prev');
    const next = g('vnav-next');
    if (!wrap || !panel) return;

    // ── wrap 内部にある UI（クロップ・ペイント・スキャン補正・比較ナビ）を安全に退避 ──
    // ※ adjustUI と paintUI は renderPanel 直下のため退避・再挿入は不要です
    const cropUIEl = document.getElementById('viewer-crop-ui');
    const paintCanvasEl = document.getElementById('viewer-paint-canvas');
    const scanfixOverlayEl = document.getElementById('viewer-scanfix-overlay');
    const cmpNavLEl = document.getElementById('compare-nav-left');
    const cmpNavREl = document.getElementById('compare-nav-right');
    if (cropUIEl) cropUIEl.remove();
    if (paintCanvasEl) paintCanvasEl.remove();
    if (scanfixOverlayEl) scanfixOverlayEl.remove();
    if (cmpNavLEl) cmpNavLEl.remove();
    if (cmpNavREl) cmpNavREl.remove();

    if (_isScroll) {
      // ── スクロールモード: 全ページを縦並びの scroll-page-wrap として構築 ──
      prev.style.display = 'none';
      next.style.display = 'none';
      
      // 見切れ防止のため safe center レイアウトを利用
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '24px';
      wrap.style.padding = '24px';
      wrap.style.margin = '0 auto';
      wrap.style.width = '100%';
      wrap.style.height = 'auto';
      wrap.innerHTML = ''; // ここでクリアしても退避済みのUIは安全
      
      initScrollObserver();

      const step = _pageLayout === 'double' ? 2 : 1;
      for (let i = 0; i < _items.length; i += step) {
        const div = document.createElement('div');
        div.className = 'scroll-page-wrap';
        div.dataset.idx = i;
        div.style.position = 'relative';
        div.style.display = 'flex';
        div.style.justifyContent = 'center';
        div.style.gap = '16px';
        div.style.width = '100%';
        div.style.minHeight = '400px'; 
        
        const canvas1 = document.createElement('canvas');
        canvas1.className = 'scroll-canvas';
        canvas1.style.display = 'block';
        canvas1.style.boxShadow = '0 8px 48px rgba(0,0,0,.55)';
        canvas1.style.borderRadius = '2px';
        canvas1.style.maxWidth = '100%';
        div.appendChild(canvas1);

        if (_pageLayout === 'double' && i + 1 < _items.length) {
          const canvas2 = document.createElement('canvas');
          canvas2.className = 'scroll-canvas right';
          canvas2.style.display = 'block';
          canvas2.style.boxShadow = '0 8px 48px rgba(0,0,0,.55)';
          canvas2.style.borderRadius = '2px';
          canvas2.style.maxWidth = '100%';
          div.appendChild(canvas2);
        }
        
        wrap.appendChild(div);
        _scrollObserver.observe(div);
      }
    } else {
      // ── 単一 / 見開き / 比較モード: 2枚のキャンバスを使う canvas ベース DOM ──
      if (_scrollObserver) {
        _scrollObserver.disconnect();
        _scrollObserver = null;
      }
      // 比較モード時は prev/next を非表示、それ以外は通常表示
      prev.style.display = _compareMode ? 'none' : '';
      next.style.display = _compareMode ? 'none' : '';

      // 元のflexレイアウトに戻す
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'row';
      wrap.style.gap = '16px';
      wrap.style.padding = '50px';
      wrap.style.margin = 'auto';
      wrap.style.justifyContent = 'center';
      wrap.style.alignItems = 'center';
      wrap.style.width = 'max-content';
      wrap.style.height = 'max-content';
      
      // プレーンなキャンバスを再生成
      wrap.innerHTML = `
          <canvas id="viewer-canvas"></canvas>
          <canvas id="viewer-canvas-right" style="display: none;"></canvas>
        `;
        
      // 退避したUI要素を復元
      if (cmpNavLEl) wrap.appendChild(cmpNavLEl);
      if (cmpNavREl) wrap.appendChild(cmpNavREl);
      if (paintCanvasEl) wrap.appendChild(paintCanvasEl);
      if (cropUIEl) wrap.appendChild(cropUIEl);
      if (scanfixOverlayEl) wrap.appendChild(scanfixOverlayEl);
    }
  }

  function calcScale(vpW, vpH, panelW, panelH) {
    if (_fitMode === '100') return 1.0;
    if (_fitMode === 'w') return panelW / vpW;
    if (_fitMode === 'h') return panelH / vpH;
    const containScale = Math.min(panelW / vpW, panelH / vpH);
    if (_fitMode === 'zoom') return containScale * _zoomLevel;
    return containScale;
  }

  // 個別ページ（または見開きペア）描画 (スクロールモード用)
  async function renderScrollItem(container, idx) {
    const item1 = _items[idx];
    const item2 = _pageLayout === 'double' && idx + 1 < _items.length ? _items[idx + 1] : null;
    
    const canvases = container.querySelectorAll('canvas');
    const canvas1 = canvases[0];
    const canvas2 = canvases[1];

    if (!canvas1 || !item1) return;

    try {
      const jsDoc1 = S.jsDocs.get(item1.fileId);
      if (!jsDoc1) return;
      const page1 = await jsDoc1.getPage(item1.pageIndex + 1);
      const totalRot1 = (page1.rotate + item1.rotation) % 360;
      
      let vp1_0;
      if (item1.scanFixData) {
        const lw = item1.scanFixData.logicalWidth  ?? item1.scanFixData.width  / 2;
        const lh = item1.scanFixData.logicalHeight ?? item1.scanFixData.height / 2;
        const w = (item1.rotation === 90 || item1.rotation === 270) ? lh : lw;
        const h = (item1.rotation === 90 || item1.rotation === 270) ? lw : lh;
        vp1_0 = { width: w, height: h };
      } else {
        vp1_0 = page1.getViewport({ scale: 1, rotation: totalRot1 });
      }

      let page2 = null, vp2_0 = null, totalRot2 = 0;
      if (item2 && canvas2) {
        const jsDoc2 = S.jsDocs.get(item2.fileId);
        if (jsDoc2) {
          page2 = await jsDoc2.getPage(item2.pageIndex + 1);
          totalRot2 = (page2.rotate + item2.rotation) % 360;
          if (item2.scanFixData) {
            const lw = item2.scanFixData.logicalWidth  ?? item2.scanFixData.width  / 2;
            const lh = item2.scanFixData.logicalHeight ?? item2.scanFixData.height / 2;
            const w = (item2.rotation === 90 || item2.rotation === 270) ? lh : lw;
            const h = (item2.rotation === 90 || item2.rotation === 270) ? lw : lh;
            vp2_0 = { width: w, height: h };
          } else {
            vp2_0 = page2.getViewport({ scale: 1, rotation: totalRot2 });
          }
        }
      }

      const panel = g('viewer-render-panel');
      const maxW = (panel?.clientWidth || 800) - 48; 
      const maxH = (panel?.clientHeight || 600) - 48;

      const totalWBase = vp1_0.width + (vp2_0 ? vp2_0.width + 16 : 0);
      const maxHBase   = Math.max(vp1_0.height, vp2_0 ? vp2_0.height : 0);
      const finalScale = Math.max(0.1, calcScale(totalWBase, maxHBase, maxW, maxH));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const renderCanvas = async (page, rot, canvas, vp_0) => {
        const wCSS = vp_0.width * finalScale;
        const hCSS = vp_0.height * finalScale;
        
        canvas.width = Math.round(wCSS * dpr);
        canvas.height = Math.round(hCSS * dpr);
        canvas.style.width = wCSS + 'px';
        canvas.style.height = hCSS + 'px';
        
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const curItem = (page === page1) ? item1 : item2;
        if (curItem && curItem.scanFixData) {
          const img = new Image();
          img.src = curItem.scanFixData.dataUrl;
          await new Promise(r => { img.onload = r; });
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(curItem.rotation * Math.PI / 180);
          const sfScale = finalScale * dpr;
          const _clw = curItem.scanFixData.logicalWidth  ?? curItem.scanFixData.width  / 2;
          const _clh = curItem.scanFixData.logicalHeight ?? curItem.scanFixData.height / 2;
          ctx.drawImage(img, -_clw * sfScale / 2, -_clh * sfScale / 2, _clw * sfScale, _clh * sfScale);
          ctx.restore();
        } else {
          const vpHD = page.getViewport({ scale: finalScale * dpr, rotation: rot });
          try {
            await page.render({ canvasContext: ctx, viewport: vpHD }).promise;
          } catch (err) {
            if (err.name !== 'RenderingCancelledException') console.error(err);
          }
        }
        // 反転適用
        if (curItem) applyFlipToCanvas(canvas, curItem);
        return hCSS;
      };

      const h1 = await renderCanvas(page1, totalRot1, canvas1, vp1_0);
      let h2 = 0;
      if (page2 && canvas2) {
        h2 = await renderCanvas(page2, totalRot2, canvas2, vp2_0);
      }
      container.style.minHeight = Math.max(h1, h2) + 'px';

    } catch (err) { console.error(err); }
  }

  async function render() {
    if (_isScroll) {
      const wrap = g('viewer-page-wrap');
      g('viewer-ld').style.display = 'none';
      
      // 表示領域内（または既にレンダリング済み）の要素を即座に再レンダリングする
      const divs = wrap.querySelectorAll('.scroll-page-wrap[data-rendered="true"]');
      divs.forEach(div => {
        const idx = parseInt(div.dataset.idx, 10);
        renderScrollItem(div, idx);
      });
      return;
    }

    const token   = ++_token;
    const canvasL = g('viewer-canvas');
    const canvasR = g('viewer-canvas-right');
    const ld      = g('viewer-ld');
    let item      = _items[_idx];

    if (!item || !canvasL) return;
    // スタンドアローン 3D アイテムは PDF.js レンダリング不要
    if (item.type === '3d') return;

    // 前回のレンダリングが実行中ならキャンセル（描画競合による消失バグ防止）
    if (_renderTaskL) { try { _renderTaskL.cancel(); } catch(e){} _renderTaskL = null; }
    if (_renderTaskR) { try { _renderTaskR.cancel(); } catch(e){} _renderTaskR = null; }

    // 描画中にペイントやクロップUIを起動した際、サイズ(offsetWidth等)が0になって
    // 編集操作を受け付けなくなるバグを防ぐため display:none ではなく opacity:0 で隠す
    canvasL.style.opacity = '0';
    if (canvasR) canvasR.style.opacity = '0';
    ld.style.display = 'flex';

    const jsDoc1 = S.jsDocs.get(item.fileId);
    if (!jsDoc1) { ld.style.display = 'none'; return; }

    try {
      let page1 = null;
      let page2 = null;
      let item2 = null;

      if (_compareMode) {
        item = _items.find(w => w.id === _compareIds[0]);
        item2 = _items.find(w => w.id === _compareIds[1]);
        if (item) {
          const jd1 = S.jsDocs.get(item.fileId);
          if (jd1) page1 = await jd1.getPage(item.pageIndex + 1);
        }
        if (item2) {
          const jsDoc2 = S.jsDocs.get(item2.fileId);
          if (jsDoc2) page2 = await jsDoc2.getPage(item2.pageIndex + 1);
        }
      } else {
        if (jsDoc1) page1 = await jsDoc1.getPage(item.pageIndex + 1);
        
        if (_pageLayout === 'double' && _idx + 1 < _items.length) {
          item2 = _items[_idx + 1];
          const jsDoc2 = S.jsDocs.get(item2.fileId);
          if (jsDoc2) page2 = await jsDoc2.getPage(item2.pageIndex + 1);
        }
      }

      if (!page1 || token !== _token) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const totalRot1 = (page1.rotate + item.rotation) % 360;
      
      const _sfLw1 = item.scanFixData ? (item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2) : 0;
      const _sfLh1 = item.scanFixData ? (item.scanFixData.logicalHeight ?? item.scanFixData.height / 2) : 0;
      const baseW1 = item.scanFixData
        ? ((item.rotation === 90 || item.rotation === 270) ? _sfLh1 : _sfLw1)
        : page1.getViewport({ scale: 1, rotation: totalRot1 }).width;
      const baseH1 = item.scanFixData
        ? ((item.rotation === 90 || item.rotation === 270) ? _sfLw1 : _sfLh1)
        : page1.getViewport({ scale: 1, rotation: totalRot1 }).height;
      const vp1_0 = { width: baseW1, height: baseH1 };

      let vp2_0 = null;
      let totalRot2 = 0;
      if (page2) {
        totalRot2 = (page2.rotate + item2.rotation) % 360;
        const _sfLw2 = item2.scanFixData ? (item2.scanFixData.logicalWidth  ?? item2.scanFixData.width  / 2) : 0;
        const _sfLh2 = item2.scanFixData ? (item2.scanFixData.logicalHeight ?? item2.scanFixData.height / 2) : 0;
        const baseW2 = item2.scanFixData
          ? ((item2.rotation === 90 || item2.rotation === 270) ? _sfLh2 : _sfLw2)
          : page2.getViewport({ scale: 1, rotation: totalRot2 }).width;
        const baseH2 = item2.scanFixData
          ? ((item2.rotation === 90 || item2.rotation === 270) ? _sfLw2 : _sfLh2)
          : page2.getViewport({ scale: 1, rotation: totalRot2 }).height;
        vp2_0 = { width: baseW2, height: baseH2 };
      }

      const panel = g('viewer-render-panel');
      // padding: 50px (上下左右の合計100px) を考慮してフィット領域を計算し、不要なスクロールバーを防ぐ
      const maxW  = (panel?.clientWidth  || 800) - 100; 
      const maxH  = (panel?.clientHeight || 600) - 100;

      const totalWBase = vp1_0.width + (vp2_0 ? vp2_0.width + 16 : 0);
      const maxHBase   = Math.max(vp1_0.height, vp2_0 ? vp2_0.height : 0);
      const finalScale = Math.max(0.1, calcScale(totalWBase, maxHBase, maxW, maxH));

      const w1CSS = vp1_0.width * finalScale;
      const h1CSS = vp1_0.height * finalScale;
      
      canvasL.width        = Math.round(w1CSS * dpr);
      canvasL.height       = Math.round(h1CSS * dpr);
      canvasL.style.width  = w1CSS + 'px';
      canvasL.style.height = h1CSS + 'px';

      const ctxL = canvasL.getContext('2d');
      ctxL.clearRect(0, 0, canvasL.width, canvasL.height);
      
      if (item.scanFixData) {
        const img = new Image();
        img.src = item.scanFixData.dataUrl;
        await new Promise(r => { img.onload = r; });
        ctxL.save();
        ctxL.translate(canvasL.width / 2, canvasL.height / 2);
        ctxL.rotate(item.rotation * Math.PI / 180);
        const sfScaleL = finalScale * dpr;
        const _sfLwL = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
        const _sfLhL = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
        ctxL.drawImage(img, -_sfLwL * sfScaleL / 2, -_sfLhL * sfScaleL / 2, _sfLwL * sfScaleL, _sfLhL * sfScaleL);
        ctxL.restore();
      } else {
        try {
          const vp1HD = page1.getViewport({ scale: finalScale * dpr, rotation: totalRot1 });
          _renderTaskL = page1.render({ canvasContext: ctxL, viewport: vp1HD });
          await _renderTaskL.promise;
        } catch (err) {
          if (err.name !== 'RenderingCancelledException') console.error('Render L Error:', err);
        }
        _renderTaskL = null;
      }
      
      if (token !== _token) return;

      let w2CSS = 0;
      let h2CSS = 0;

      if (page2 && canvasR) {
        w2CSS = vp2_0.width * finalScale;
        h2CSS = vp2_0.height * finalScale;
        
        canvasR.width        = Math.round(w2CSS * dpr);
        canvasR.height       = Math.round(h2CSS * dpr);
        canvasR.style.width  = w2CSS + 'px';
        canvasR.style.height = h2CSS + 'px';

        const ctxR = canvasR.getContext('2d');
        ctxR.clearRect(0, 0, canvasR.width, canvasR.height);
        
        if (item2.scanFixData) {
          const img = new Image();
          img.src = item2.scanFixData.dataUrl;
          await new Promise(r => { img.onload = r; });
          ctxR.save();
          ctxR.translate(canvasR.width / 2, canvasR.height / 2);
          ctxR.rotate(item2.rotation * Math.PI / 180);
          const sfScaleR = finalScale * dpr;
          const _sfLwR = item2.scanFixData.logicalWidth  ?? item2.scanFixData.width  / 2;
          const _sfLhR = item2.scanFixData.logicalHeight ?? item2.scanFixData.height / 2;
          ctxR.drawImage(img, -_sfLwR * sfScaleR / 2, -_sfLhR * sfScaleR / 2, _sfLwR * sfScaleR, _sfLhR * sfScaleR);
          ctxR.restore();
        } else {
          try {
            const vp2HD = page2.getViewport({ scale: finalScale * dpr, rotation: totalRot2 });
            _renderTaskR = page2.render({ canvasContext: ctxR, viewport: vp2HD });
            await _renderTaskR.promise;
          } catch (err) {
            if (err.name !== 'RenderingCancelledException') console.error('Render R Error:', err);
          }
          _renderTaskR = null;
        }
        
        if (token !== _token) return;
      }

      const pageWrap = g('viewer-page-wrap');
      if (pageWrap) {
        const w1 = w1CSS;
        const w2 = page2 && canvasR ? w2CSS + 16 : 0;
        const h1 = h1CSS;
        const h2 = page2 && canvasR ? h2CSS : 0;
        // padding: 50px (左右/上下の合計100px) を考慮してコンテナサイズを設定し、
        // canvas の max-width: 100% による意図しないアスペクト比の圧縮・歪みを防止する
        pageWrap.style.width  = (w1 + w2 + 100) + 'px';
        pageWrap.style.height = (Math.max(h1, h2) + 100) + 'px';
      }

      ld.style.display = 'none';
      canvasL.style.display = 'block';
      canvasL.style.opacity = '1';
      if (page2 && canvasR) {
        canvasR.style.display = 'block';
        canvasR.style.opacity = '1';
      }

      // フィルター適用
      const fStr = getFilterString(item.filters);
      canvasL.style.filter = fStr;
      if (canvasR) canvasR.style.filter = item2 ? getFilterString(item2.filters) : 'none';

      // 反転適用（ペイント合成前に実行し、ペイントデータが反転されないようにする）
      applyFlipToCanvas(canvasL, item);
      if (page2 && canvasR && item2) applyFlipToCanvas(canvasR, item2);

      // ペイントデータがあれば合成
      if (item.paintData) {
        const img = new Image();
        img.src = item.paintData.dataUrl;
        await new Promise(r => { img.onload = r; });
        ctxL.drawImage(img, 0, 0, canvasL.width, canvasL.height);
      }

      // 比較モード用ナビゲーションの表示と状態更新
      const cmpNavL = g('compare-nav-left');
      const cmpNavR = g('compare-nav-right');
      if (_compareMode) {
        if (cmpNavL) {
          cmpNavL.classList.remove('hidden');
          // キャンバスの垂直・水平の中央に配置
          cmpNavL.style.left = (canvasL.offsetLeft + canvasL.offsetWidth / 2) + 'px';
          cmpNavL.style.top = (canvasL.offsetTop + canvasL.offsetHeight / 2) + 'px';
          const idxL = _items.findIndex(w => w.id === _compareIds[0]);
          g('vnav-cmp-l-prev').disabled = idxL <= 0 || (idxL === 1 && _items[0].id === _compareIds[1]);
          g('vnav-cmp-l-next').disabled = idxL >= _items.length - 1 || (idxL === _items.length - 2 && _items[_items.length - 1].id === _compareIds[1]);
          const pnumL = g('cmp-pnum-l');
          if (pnumL) pnumL.textContent = `${idxL + 1} / ${_items.length}`;
        }
        if (cmpNavR && page2) {
          cmpNavR.classList.remove('hidden');
          // キャンバスの垂直・水平の中央に配置
          cmpNavR.style.left = (canvasR.offsetLeft + canvasR.offsetWidth / 2) + 'px';
          cmpNavR.style.top = (canvasR.offsetTop + canvasR.offsetHeight / 2) + 'px';
          const idxR = _items.findIndex(w => w.id === _compareIds[1]);
          g('vnav-cmp-r-prev').disabled = idxR <= 0 || (idxR === 1 && _items[0].id === _compareIds[0]);
          g('vnav-cmp-r-next').disabled = idxR >= _items.length - 1 || (idxR === _items.length - 2 && _items[_items.length - 1].id === _compareIds[0]);
          const pnumR = g('cmp-pnum-r');
          if (pnumR) pnumR.textContent = `${idxR + 1} / ${_items.length}`;
        }
      } else {
        if (cmpNavL) cmpNavL.classList.add('hidden');
        if (cmpNavR) cmpNavR.classList.add('hidden');
      }

      // クロップ適用中インジケータを描画
      drawCropIndicator(canvasL, item.cropBox);
      updateCropBadge(!!item.cropBox);
    } catch (err) {
      if (err.name !== 'RenderingCancelledException') console.error('Render Main Error:', err);
      if (token !== _token) return;
      ld.style.display = 'none';
    }
  }

  function drawCropIndicator(canvas, cropBox) {
    if (!canvas || !cropBox) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    const px = Math.round(cropBox.x * cw);
    const py = Math.round(cropBox.y * ch);
    const pw = Math.round(cropBox.width  * cw);
    const ph = Math.round(cropBox.height * ch);

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0,  0,  cw, py);              // top
    ctx.fillRect(0,  py + ph, cw, ch - py - ph); // bottom
    ctx.fillRect(0,  py, px, ph);              // left
    ctx.fillRect(px + pw, py, cw - px - pw, ph); // right

    // クロップ枠のボーダー
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth   = Math.max(1.5, cw / 400);
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(px, py, pw, ph);

    // コーナー強調
    const corner = Math.min(pw, ph, 20);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth   = Math.max(2, cw / 200);
    ctx.setLineDash([]);
    [[px, py, corner, 0, 0, corner], [px+pw, py, -corner, 0, 0, corner],
     [px, py+ph, corner, 0, 0, -corner], [px+pw, py+ph, -corner, 0, 0, -corner]].forEach(([ox, oy, dx1, dy1, dx2, dy2]) => {
      ctx.beginPath(); ctx.moveTo(ox + dx1, oy + dy1); ctx.lineTo(ox, oy); ctx.lineTo(ox + dx2, oy + dy2); ctx.stroke();
    });
    ctx.restore();
  }

  function updateCropBadge(visible) {
    const badge = g('viewer-crop-badge');
    if (badge) badge.classList.toggle('hidden', !visible);
  }

  function switchTab(tab) {
    _currentTab = tab;
    const renderPanel = g('viewer-render-panel');
    const textPanel   = g('viewer-text-panel');
    const panel3d     = g('viewer-3d-panel');
    const tabRender   = g('vtab-render');
    const tabText     = g('vtab-text');
    const tab3d       = g('vtab-3d');

    renderPanel?.classList.add('hidden');
    textPanel?.classList.add('hidden');
    panel3d?.classList.add('hidden');
    tabRender?.classList.remove('active');
    tabText?.classList.remove('active');
    tab3d?.classList.remove('active');

    if (tab === 'render') {
      renderPanel?.classList.remove('hidden');
      tabRender?.classList.add('active');
      updateCropBadge(!!_items[_idx]?.cropBox);
      ThreeViewer.stop();
    } else if (tab === 'text') {
      textPanel?.classList.remove('hidden');
      tabText?.classList.add('active');
      updateCropBadge(false);
      ThreeViewer.stop();
      if (_items[_idx]) loadText(_items[_idx]);
    } else if (tab === '3d') {
      panel3d?.classList.remove('hidden');
      tab3d?.classList.add('active');
      updateCropBadge(false);
      const cur = _items[_idx];
      if (cur?.type === '3d') {
        // スタンドアローン 3D ファイル
        PDF3DPanel.hide();
        ThreeViewer.show(cur);
      } else if (cur?.has3D) {
        // PDF 埋め込み 3D アノテーション
        ThreeViewer.stop();
        PDF3DPanel.show(cur);
      }
    }
  }

  let _textPrevToken = 0;

  async function renderTextPreview(item) {
    const token = ++_textPrevToken;
    const canvas = g('vt-prev-canvas');
    const ld = g('vt-prev-ld');
    if (!canvas || !ld) return;

    canvas.style.display = 'none';
    ld.style.display = 'flex';

    const jsDoc = S.jsDocs.get(item.fileId);
    if (!jsDoc) { ld.style.display = 'none'; return; }

    try {
      const page = await jsDoc.getPage(item.pageIndex + 1);
      if (token !== _textPrevToken) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const totalRot = (page.rotate + item.rotation) % 360;
      const vp0 = page.getViewport({ scale: 1, rotation: totalRot });

      const wrap = g('vt-prev-wrap');
      const maxW = (wrap.clientWidth || 400) - 32;
      const maxH = (wrap.clientHeight || 500) - 32;
      const scale = Math.min(maxW / vp0.width, maxH / vp0.height, 3) * dpr;
      const vp = page.getViewport({ scale, rotation: totalRot });

      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = Math.round(vp.width / dpr) + 'px';
      canvas.style.height = Math.round(vp.height / dpr) + 'px';

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (item.scanFixData) {
        const img = new Image();
        img.src = item.scanFixData.dataUrl;
        await new Promise(r => { img.onload = r; });
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(item.rotation * Math.PI / 180);
        const sfScale = scale;
        const _sfLw = item.scanFixData.logicalWidth ?? item.scanFixData.width / 2;
        const _sfLh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
        ctx.drawImage(img, -_sfLw * sfScale / 2, -_sfLh * sfScale / 2, _sfLw * sfScale, _sfLh * sfScale);
        ctx.restore();
      } else {
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }

      const fStr = getFilterString(item.filters);
      if (fStr !== 'none') canvas.style.filter = fStr;
      else canvas.style.filter = 'none';

      applyFlipToCanvas(canvas, item);

      if (token !== _textPrevToken) return;
      ld.style.display = 'none';
      canvas.style.display = 'block';
    } catch {
      if (token !== _textPrevToken) return;
      ld.style.display = 'none';
    }
  }

  async function loadText(item) {
    const ta     = g('viewer-text-area');
    const badge  = g('viewer-text-src-badge');
    const mjWrap = g('viewer-mojibake-wrap');
    if (!ta) return;

    ta.value = '';
    if (badge) { badge.className = 'vt-src-badge'; badge.innerHTML = ''; }
    mjWrap?.classList.add('hidden');

    renderTextPreview(item);

    const applyTextUI = (text, source) => {
      ta.value = text;
      ta.placeholder = '';
      _showTextBadge(badge, source);
      if (source === 'text' && detectMojibake(text)) mjWrap?.classList.remove('hidden');
    };

    if (_textCache.has(item.id)) {
      const cached = _textCache.get(item.id);
      applyTextUI(cached.text, cached.source);
      return;
    }

    ta.placeholder = 'テキストを読み込んでいます...';
    const jsDoc = S.jsDocs.get(item.fileId);
    if (jsDoc) {
      try {
        const page = await jsDoc.getPage(item.pageIndex + 1);
        const has  = await pageHasText(page);
        if (has) {
          const text = await extractPageText(page);
          if (text) {
            _textCache.set(item.id, { text, source: 'text', originalText: text });
            item.textContent = text;
            applyTextUI(text, 'text');
            return;
          }
        }
      } catch { /* silent */ }
    }

    ta.placeholder = 'テキスト層がありません。\nOCR機能をご利用ください：上部のOCRボタン（ ) または\nツールバーの OCR ボタンから実行できます。';
    _showTextBadge(badge, 'none');
  }

  function _showTextBadge(el, source) {
    if (!el) return;
    el.className = 'vt-src-badge';
    if (source === 'text') {
      el.classList.add('src-text');
      el.innerHTML = '<i class="fa-solid fa-font"></i>テキスト抽出';
    } else if (source === 'ocr') {
      el.classList.add('src-ocr');
      el.innerHTML = '<i class="fa-solid fa-language"></i>OCR認識';
    } else if (source === 'none') {
      el.classList.add('src-none');
      el.innerHTML = '<i class="fa-solid fa-image"></i>画像ページ';
    }
  }

  function updateHeader() {
    const item = _items[_idx];
    const f    = item ? S.files.get(item.fileId) : null;
    let pnumText = `ページ ${_idx + 1}`;
    if (_pageLayout === 'double' && _idx + 1 < _items.length) pnumText += ` - ${_idx + 2}`;
    pnumText += ` / ${_items.length}`;
    g('vhd-pnum').textContent  = pnumText;
    g('vhd-fname').textContent = f ? f.name : '';

    const badgesEl = g('vhd-status-badges');
    if (badgesEl && item) {
      const badges = [];
      if (item.cropBox) badges.push(`<span class="badge-crop" title="クロップ適用中"><i class="fa-solid fa-crop-simple"></i> クロップ</span>`);
      if (item.scanFixData) badges.push(`<span class="badge-scanfix" title="スキャン補正適用中"><i class="fa-solid fa-object-ungroup"></i> 補正済</span>`);
      if (item.paintData) badges.push(`<span class="badge-paint" title="ペイント適用中"><i class="fa-solid fa-paintbrush"></i> ペイント</span>`);
      if (item.filters && getFilterString(item.filters) !== 'none') badges.push(`<span class="badge-filter" title="画像調整適用中"><i class="fa-solid fa-sliders"></i> フィルタ</span>`);
      if (item.flipH || item.flipV) badges.push(`<span class="badge-flip" title="反転適用中"><i class="fa-solid fa-left-right"></i> 反転</span>`);
      if (item.textContent) badges.push(`<span class="badge-ocr" title="テキスト抽出済み"><i class="fa-solid fa-language"></i> OCR済</span>`);
      if (item.has3D) badges.push(`<span class="badge-3d" title="3Dデータを含む"><i class="fa-solid fa-cube"></i> 3D</span>`);
      badgesEl.innerHTML = badges.join('');
    } else if (badgesEl) {
      badgesEl.innerHTML = '';
    }

    g('vnav-prev').disabled    = _idx <= 0;
    const maxIdx = _pageLayout === 'double' ? _items.length - 2 : _items.length - 1;
    g('vnav-next').disabled    = _idx >= Math.max(0, maxIdx);
    g('vhd-flip-h')?.classList.toggle('active', !!item?.flipH);
    g('vhd-flip-v')?.classList.toggle('active', !!item?.flipV);
  }

  function open(itemId) {
    _items     = [...S.ws];
    _idx       = _items.findIndex(w => w.id === itemId);
    
    // 見開き表示で奇数インデックス(0始まりなので1,3,5...)を開いた場合、前の偶数ページから表示するよう調整
    if (_pageLayout === 'double' && _idx % 2 !== 0) {
      _idx = Math.max(0, _idx - 1);
    }
    
    _currentId = itemId;
    if (_idx < 0 || !_items.length) return;
    _open = true;

    const item = _items[_idx];
    const is3D     = item?.type === '3d';
    const hasPDF3D = !is3D && !!item?.has3D;
    const needsTab3D = is3D || hasPDF3D;

    // PDF専用コントロールを 3D 時は隠す
    const pdfOnlyBtns = [g('vhd-crop'), g('vhd-ocr'), g('vhd-rot-l'), g('vhd-rot-r'),
      g('vhd-fit-100'), g('vhd-fit-w'), g('vhd-fit-h'), g('vhd-zoom-ctrl')];
    pdfOnlyBtns.forEach(el => el && (el.style.display = is3D ? 'none' : ''));
    document.querySelectorAll('.vhd-divider').forEach((el, i) => {
      if (i === 0) el.style.display = is3D ? 'none' : '';
      if (i === 1) el.style.display = is3D ? 'none' : '';
    });

    // 3D タブ表示制御
    const tab3d = g('vtab-3d');
    const tabRender = g('vtab-render');
    const tabText = g('vtab-text');
    tab3d?.classList.toggle('hidden', !needsTab3D);

    // 3Dモデル専用ファイルの場合、表示・テキストタブを無効化
    if (is3D) {
      if (tabRender) { tabRender.disabled = true; tabRender.title = "3Dモデルデータでは使用できません"; }
      if (tabText)   { tabText.disabled = true;   tabText.title = "3Dモデルデータでは使用できません"; }
      _currentTab = '3d';
    } else {
      if (tabRender) { tabRender.disabled = false; tabRender.title = "ページ表示"; }
      if (tabText)   { tabText.disabled = false;   tabText.title = "テキスト抽出・コピー"; }
      _currentTab = 'render';
    }

    g('viewer-render-panel')?.classList.remove('hidden');
    g('viewer-text-panel')?.classList.add('hidden');
    g('viewer-3d-panel')?.classList.add('hidden');

    g('vtab-render')?.classList.remove('active');
    g('vtab-text')?.classList.remove('active');
    tab3d?.classList.remove('active');
    
    if (_currentTab === 'render') {
      g('vtab-render')?.classList.add('active');
    }

    // PDF 3D ページを開く際に is3D standalone はレンダリングパネルのまま開始
    initRenderPanelDOM();
    g('viewer-overlay').classList.remove('hidden');
    updateHeader();
    updateCropBadge(false);

    if (is3D) {
      switchTab('3d');
    } else if (_isScroll) {
      setTimeout(() => {
        const wrap = g('viewer-page-wrap');
        const targetIdx = _pageLayout === 'double' ? _idx - (_idx % 2) : _idx;
        const targetDiv = wrap.querySelector(`.scroll-page-wrap[data-idx="${targetIdx}"]`);
        const renderPanel = g('viewer-render-panel');
        if (targetDiv && renderPanel) renderPanel.scrollTop = targetDiv.offsetTop - 24; 
      }, 50);
    } else {
      requestAnimationFrame(() => render());
    }
  }

  function close() {
    _open      = false;
    _currentId = null;
    _token++;
    closeEditUIs();
    ThreeViewer.stop();
    PDF3DPanel.hide();
    
    if (_compareMode) {
      _compareMode = false;
      document.body.classList.remove('compare-active');
      _pageLayout = _originalLayout;
      g('vhd-view-single')?.classList.toggle('active', _pageLayout === 'single');
      g('vhd-view-double')?.classList.toggle('active', _pageLayout === 'double');
      g('vnav-prev').style.display = '';
      g('vnav-next').style.display = '';
      const viewControls = [g('vhd-view-single'), g('vhd-view-double'), g('vhd-view-scroll')];
      viewControls.forEach(el => { if (el) el.style.display = ''; });
    }

    if (_scrollObserver) {
      _scrollObserver.disconnect();
      _scrollObserver = null;
    }
    g('viewer-overlay').classList.add('hidden');
    updateCropBadge(false);
  }

  function navigate(delta) {
    if (_isScroll) return; 
    closeEditUIs();
    const step = _pageLayout === 'double' ? delta * 2 : delta;
    let ni = _idx + step;
    
    // 見開きモード時の範囲チェックを厳格にする
    if (_pageLayout === 'double') {
      if (ni < 0) ni = 0;
      if (ni >= _items.length) ni = _items.length - 1;
      // 常に偶数インデックス(0, 2, 4...)を維持する
      if (ni % 2 !== 0) ni = Math.max(0, ni - 1);
    } else {
      if (ni < 0) ni = 0;
      if (ni >= _items.length) ni = _items.length - 1;
    }
    
    if (_idx === ni) return;
    
    _idx       = ni;
    _currentId = _items[_idx].id;
    updateHeader();

    const item      = _items[_idx];
    const is3D      = item?.type === '3d';
    const hasPDF3D  = !is3D && !!item?.has3D;
    const needsTab3D = is3D || hasPDF3D;
    const tab3d     = g('vtab-3d');
    const tabRender = g('vtab-render');
    const tabText   = g('vtab-text');
    
    tab3d?.classList.toggle('hidden', !needsTab3D);
    
    if (is3D) {
      if (tabRender) { tabRender.disabled = true; tabRender.title = "3Dモデルデータでは使用できません"; }
      if (tabText)   { tabText.disabled = true;   tabText.title = "3Dモデルデータでは使用できません"; }
    } else {
      if (tabRender) { tabRender.disabled = false; tabRender.title = "ページ表示"; }
      if (tabText)   { tabText.disabled = false;   tabText.title = "テキスト抽出・コピー"; }
    }

    if (is3D) {
      switchTab('3d');
    } else {
      // PDF ページ：3Dタブが表示されていた場合はページ表示に戻す
      if (_currentTab === '3d') switchTab('render');
      render();
      if (_currentTab === 'text') loadText(item);
    }
  }

  function openWithTool(itemId, toolBtnId) {
    // ツールを開く前に確実に単一表示＆スクロール解除状態にする
    if (_isScroll) {
      _isScroll = false;
      g('vhd-view-scroll')?.classList.remove('active');
    }
    if (_pageLayout !== 'single') {
      _pageLayout = 'single';
      g('vhd-view-single')?.classList.add('active');
      g('vhd-view-double')?.classList.remove('active');
    }

    open(itemId);

    // 開いた直後はDOMの初期化や非同期レンダリングが行われるため、
    // キャンバスが準備されるまで少し待機してからツールボタンをクリックする
    setTimeout(() => {
      const btn = g(toolBtnId);
      if (btn && !btn.classList.contains('active')) {
        btn.click();
      }
    }, 350);
  }

  function rerender() {
    if (!_open || !_items[_idx]) return;
    const live = S.ws.find(w => w.id === _items[_idx].id);
    if (live) {
      _items[_idx].rotation = live.rotation;
      _items[_idx].cropBox  = live.cropBox;
    }
    const cached = _textCache.get(_items[_idx].id);
    if (cached?.source === 'ocr') _textCache.delete(_items[_idx].id);
    render();
    if (_currentTab === 'text') loadText(_items[_idx]);
  }

  function openCompare(id1, id2) {
    _compareMode = true;
    document.body.classList.add('compare-active');
    _items = [...S.ws];
    _compareIds = [id1, id2];
    _idx = _items.findIndex(w => w.id === id1);
    _currentId = id1;
    _open = true;

    _originalLayout = _pageLayout;
    _pageLayout = 'compare';
    _isScroll = false;
    
    g('vhd-view-single')?.classList.remove('active');
    g('vhd-view-double')?.classList.add('active');
    g('vhd-view-scroll')?.classList.remove('active');

    // 比較中はレイアウト変更やナビゲーションを隠す
    g('vnav-prev').style.display = 'none';
    g('vnav-next').style.display = 'none';
    const viewControls = [g('vhd-view-single'), g('vhd-view-double'), g('vhd-view-scroll')];
    viewControls.forEach(el => { if (el) el.style.display = 'none'; });

    g('viewer-render-panel')?.classList.remove('hidden');
    g('viewer-text-panel')?.classList.add('hidden');
    g('viewer-3d-panel')?.classList.add('hidden');
    
    initRenderPanelDOM();
    g('viewer-overlay').classList.remove('hidden');
    
    g('vhd-pnum').textContent  = `比較モード (2ページ)`;
    g('vhd-fname').textContent = '';

    switchTab('render');
    requestAnimationFrame(() => render());
  }

  return { buildDOM, open, openWithTool, openCompare, close, navigate, rerender, get isOpen() { return _open; }, get currentId() { return _currentId; }, drawCropIndicator, updateCropBadge };
})();

// ============================================================
// THREE.JS 3D VIEWER
// ============================================================
const ThreeViewer = (() => {
  let _renderer  = null;
  let _scene     = null;
  let _camera    = null;
  let _controls  = null;
  let _animId    = null;
  let _model     = null;
  let _grid      = null;
  let _wireframe = false;
  let _showGrid  = true;
  let _fileId    = null;

  function _ensureRenderer(canvas) {
    if (_renderer && _renderer.domElement === canvas) return true;
    _disposeRenderer();

    try {
      _renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      _renderer.outputEncoding = THREE.sRGBEncoding;
      _renderer.shadowMap.enabled = true;
      _renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      _renderer.setClearColor(0x1b2438, 1);

      _scene  = new THREE.Scene();

      // 環境光
      _scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      // 主光源（シャドウ付き）
      const sun = new THREE.DirectionalLight(0xffffff, 0.90);
      sun.position.set(5, 10, 6);
      sun.castShadow = true;
      _scene.add(sun);
      // 補助光
      const fill = new THREE.DirectionalLight(0x8cb4d4, 0.35);
      fill.position.set(-4, -2, -5);
      _scene.add(fill);
      const rim = new THREE.DirectionalLight(0xffd6a0, 0.25);
      rim.position.set(0, -8, 4);
      _scene.add(rim);

      // グリッド
      _grid = new THREE.GridHelper(20, 40, 0x2a3a5c, 0x1e2d45);
      _scene.add(_grid);

      // カメラ
      _camera = new THREE.PerspectiveCamera(45, 1, 0.001, 5000);
      _camera.position.set(3, 2.5, 4);

      // OrbitControls
      _controls = new THREE.OrbitControls(_camera, canvas);
      _controls.enableDamping    = true;
      _controls.dampingFactor    = 0.06;
      _controls.screenSpacePanning = true;
      _controls.minDistance      = 0.01;
      _controls.maxDistance      = 2000;

      return true;
    } catch (e) {
      console.error('ThreeViewer init error', e);
      _disposeRenderer();
      return false;
    }
  }

  function _disposeRenderer() {
    if (_animId) { cancelAnimationFrame(_animId); _animId = null; }
    if (_model)  { _clearModel(); }
    if (_renderer) {
      _renderer.dispose();
      _renderer = null;
    }
    _scene = _camera = _controls = _grid = null;
  }

  function _clearModel() {
    if (!_model || !_scene) return;
    _scene.remove(_model);
    _model.traverse(o => {
      if (o.isMesh) {
        o.geometry?.dispose();
        [].concat(o.material).forEach(m => m?.dispose());
      }
    });
    _model = null;
  }

  function _fitCamera() {
    if (!_model || !_camera || !_controls) return;
    const box    = new THREE.Box3().setFromObject(_model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov    = _camera.fov * (Math.PI / 180);
    const dist   = Math.abs(maxDim / Math.tan(fov / 2)) * 1.6;

    _camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.8);
    _camera.lookAt(center);
    _controls.target.copy(center);

    // グリッドをモデル底面に合わせる
    if (_grid) _grid.position.y = box.min.y;

    _controls.update();
  }

  function _startLoop(canvas) {
    if (_animId) cancelAnimationFrame(_animId);
    const loop = () => {
      _animId = requestAnimationFrame(loop);
      if (!_renderer || !_scene || !_camera || !_controls) return;
      _controls.update();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        _renderer.setSize(w, h, false);
        _camera.aspect = w / h;
        _camera.updateProjectionMatrix();
      }
      _renderer.render(_scene, _camera);
    };
    loop();
  }

  async function show(item) {
    if (!HAS_THREE) return;
    const canvas = g('viewer-3d-canvas');
    const ldEl   = g('viewer-3d-ld');
    const errEl  = g('viewer-3d-err');
    const fnEl   = g('viewer-3d-filename');
    if (!canvas) return;

    const fileData = S.files.get(item.fileId);
    if (!fileData) return;

    if (fnEl) fnEl.textContent = fileData.name;

    // 同じファイルが既に表示中なら再読み込み不要
    const sameFile = _fileId === item.fileId && _model && _renderer;
    if (!sameFile) {
      ldEl?.classList.remove('hidden');
      errEl?.classList.add('hidden');

      if (!_ensureRenderer(canvas)) {
        ldEl?.classList.add('hidden');
        errEl?.classList.remove('hidden');
        return;
      }

      _clearModel();
      _fileId = item.fileId;

      const obj = await load3DModel(fileData);
      if (!obj) {
        ldEl?.classList.add('hidden');
        errEl?.classList.remove('hidden');
        return;
      }

      _model = obj;
      _scene.add(_model);
      _fitCamera();
      ldEl?.classList.add('hidden');
    }

    _startLoop(canvas);
  }

  function stop() {
    if (_animId) { cancelAnimationFrame(_animId); _animId = null; }
  }

  function stopIfFile(fileId) {
    if (_fileId === fileId) { stop(); _clearModel(); _fileId = null; }
  }

  function resetCamera() { _fitCamera(); }

  function toggleWireframe() {
    _wireframe = !_wireframe;
    if (_model) {
      _model.traverse(o => {
        if (o.isMesh) [].concat(o.material).forEach(m => { m.wireframe = _wireframe; });
      });
    }
    return _wireframe;
  }

  function toggleGrid() {
    _showGrid = !_showGrid;
    if (_grid) _grid.visible = _showGrid;
    return _showGrid;
  }

  /**
   * 外部から生成済み THREE.Mesh / THREE.Object3D を直接表示する。
   * PRCParser 等の外部パーサ結果を ThreeViewer に統合するためのAPI。
   * @param {HTMLCanvasElement} canvas 描画対象キャンバス
   * @param {THREE.Object3D} meshObj 表示するオブジェクト
   * @param {string} syntheticFileId 重複ロード防止用の識別子
   */
  async function showMesh(canvas, meshObj, syntheticFileId) {
    if (!HAS_THREE || !canvas || !meshObj) return;
    const ldEl = g('viewer-3d-ld');
    const errEl = g('viewer-3d-err');

    // 同一IDが既に表示中なら再ロード不要
    const sameFile = _fileId === syntheticFileId && _model && _renderer;
    if (!sameFile) {
      ldEl?.classList.remove('hidden');
      errEl?.classList.add('hidden');

      if (!_ensureRenderer(canvas)) {
        ldEl?.classList.add('hidden');
        errEl?.classList.remove('hidden');
        return;
      }
      _clearModel();
      _fileId = syntheticFileId;
      _model = meshObj;
      _scene.add(_model);
      _fitCamera();
      ldEl?.classList.add('hidden');
    }
    _startLoop(canvas);
  }

  return { show, showMesh, stop, stopIfFile, resetCamera, toggleWireframe, toggleGrid };
})();

// ============================================================
// RENDER
// ============================================================
function renderAll() {
  renderSidebar();
  renderWorkspace();
  syncUI();
  checkEmpty();
}

function renderSidebar() {
  const fl = g('file-list');
  
  const activeFiles = new Map();
  S.ws.forEach(w => {
    activeFiles.set(w.fileId, (activeFiles.get(w.fileId) || 0) + 1);
  });

  g('sb-cnt').textContent = `${activeFiles.size}件`;

  if (activeFiles.size === 0) {
    fl.innerHTML = `<div class="sb-empty">
      <i class="fa-regular fa-folder-open"></i>
      <p>PDFや画像を追加すると<br>ここに一覧表示されます</p></div>`;
    return;
  }
  
  fl.innerHTML = '';
  S.files.forEach(f => {
    const count = activeFiles.get(f.id);
    if (!count) return;

    const d = document.createElement('div');
    d.className = 'fc';
    const is3D   = f.fileType === '3d';
    const fIcon  = is3D ? 'fa-solid fa-cube' : 'fa-regular fa-file-pdf';
    const fLabel = is3D ? `3Dデータ (${(f.ext||'').toUpperCase()})` : `${count}ページ`;
    const dispName = f.alias || f.name;
    d.innerHTML = `
      <div class="fc-dot" style="background:${f.color}"></div>
      <div class="fc-info">
        <div class="fc-name" title="${dispName}">${dispName}</div>
        <div class="fc-meta"><i class="${fIcon}"></i>${fLabel}</div>
      </div>
      <div class="fc-acts">
        ${!is3D ? `<button class="fc-btn info" title="文書プロパティを表示"
          onclick="event.stopPropagation();DocProps.open('${f.id}')">
          <i class="fa-solid fa-circle-info"></i></button>` : ''}
        <button class="fc-btn" title="このファイルのページをすべて選択"
          onclick="event.stopPropagation();selFile('${f.id}')">
          <i class="fa-solid fa-check-square"></i></button>
        <button class="fc-btn dng" title="このファイルを削除"
          onclick="event.stopPropagation();removeFile('${f.id}')">
          <i class="fa-solid fa-trash"></i></button>
      </div>`;
    d.addEventListener('click', () => selFile(f.id));
    fl.appendChild(d);
  });
}

function renderWorkspace() {
  const pc = g('page-container');
  pc.className = S.view === 'th' ? 'vt' : 'vl';
  pc.innerHTML = '';

  let target = pc;
  if (S.view === 'li') {
    const hd = document.createElement('div');
    hd.className = 'lv-hd lv-cols';
    hd.innerHTML =
      '<span></span>' +
      '<span style="text-align:center">ページ</span>' +
      '<span>ファイル名</span>' +
      '<span style="text-align:center">サイズ</span>' +
      '<span style="text-align:center">回転</span>' +
      '<span></span>';
    pc.appendChild(hd);
    const wrap = document.createElement('div');
    wrap.id = 'sort-wrap';
    pc.appendChild(wrap);
    target = wrap;
  }

  S.ws.forEach((item, idx) => {
    const f = S.files.get(item.fileId);
    if (!f) return;
    const el = S.view === 'th' ? makeCard(item, f, idx) : makeRow(item, f, idx);
    el.style.animationDelay = `${Math.min(idx * 0.012, 0.24)}s`;
    target.appendChild(el);
  });

  // 常時表示の追加ボタン
  if (S.ws.length > 0) {
    const addBtn = document.createElement('div');
    addBtn.className = S.view === 'th' ? 'pc pc-add' : 'pr pr-add';
    addBtn.title = 'クリックまたはファイルをドロップして追加';
    addBtn.innerHTML = S.view === 'th' 
      ? `<div class="pc-add-inner"><i class="fa-solid fa-plus"></i><span>ファイルを追加</span></div>`
      : `<div class="pr-add-inner"><i class="fa-solid fa-plus"></i><span>ファイルを追加 (ドロップ可能)</span></div>`;
    addBtn.addEventListener('click', () => g('file-input').click());
    target.appendChild(addBtn);
  }

  setCardSize(S.cardSize);
  initSort(target);
  if (S.view === 'th') layoutMasonry();
}

// ============================================================
// CARD FACTORIES
// ============================================================
function makeCard(item, f, idx) {
  const d = document.createElement('div');
  d.className = 'pc' + (S.sel.has(item.id) ? ' sel' : '');
  d.dataset.id = item.id;
  
  // 初期レンダリング時から解像度に応じた幅を確保
  d.style.width = computeCardW(item) + 'px';

  const is3D = item.type === '3d';
  
  const selArr = [...S.sel];
  const selIdx = selArr.indexOf(item.id);
  const badgeText = selIdx >= 0 ? selIdx + 1 : '';
  const thumb = item.thumbnail
    ? `<img class="ti" src="${item.thumbnail}" alt="">`
    : is3D
      ? `<div class="pc-3d-icon"><i class="fa-solid fa-cube"></i><span>${(f.ext || '3D').toUpperCase()}</span></div>`
      : `<div class="ld"><i class="fa-solid fa-spinner"></i><span>読込中</span></div>`;

  const rotCls    = item.rotation !== 0 ? 'pc-rot-badge visible' : 'pc-rot-badge';
  const cropBadge = item.cropBox
    ? `<div class="pc-crop-badge" title="クロップ適用中"><i class="fa-solid fa-crop-simple"></i></div>` : '';
  const has3DBadge = item.has3D
    ? `<div class="pc-3d-badge" title="3Dデータを含むページ"><i class="fa-solid fa-cube"></i>3D</div>` : '';
  const memoBadge = item.memo
    ? `<div class="pc-memo-badge" title="${escHtml(item.memo)}"><i class="fa-solid fa-note-sticky"></i></div>` : '';

  const dispName = f.alias || f.name;

  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  d.innerHTML = `
    <div class="pc-sel-badge">${badgeText}</div>
    ${memoBadge}
    <div class="pc-acts">
      <button class="ic-btn memo" title="メモを編集"
        onclick="event.stopPropagation();editMemo('${item.id}')">
        <i class="fa-solid fa-pen-to-square"></i></button>
      ${!is3D ? `
      <button class="ic-btn rot" title="左90度回転"
        onclick="event.stopPropagation();rotatePage('${item.id}',-90)">
        <i class="fa-solid fa-rotate-left"></i></button>
      <button class="ic-btn rot" title="右90度回転"
        onclick="event.stopPropagation();rotatePage('${item.id}',90)">
        <i class="fa-solid fa-rotate-right"></i></button>` : ''}
      <button class="ic-btn del" title="削除"
        onclick="event.stopPropagation();delPage('${item.id}')">
        <i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="pc-area" title="ダブルクリックで拡大プレビュー">
      ${!is3D ? `<div class="${rotCls}"><i class="fa-solid fa-rotate"></i> ${item.rotation}°</div>` : ''}
      ${cropBadge}${has3DBadge}
      ${thumb}
    </div>
    <div class="pc-foot">
      <span class="pc-num">${idx + 1}</span>
      <span class="fb" style="background:${f.color}" title="ダブルクリックで名前を編集">${truncName(dispName)}</span>
    </div>`;

  applyRot(d.querySelector('.pc-area'), item);

  const fb = d.querySelector('.fb');
  if (fb) {
    fb.addEventListener('dblclick', e => {
      e.stopPropagation();
      fb.contentEditable = true;
      fb.focus();
      const range = document.createRange();
      range.selectNodeContents(fb);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    fb.addEventListener('blur', () => {
      fb.contentEditable = false;
      const newAlias = fb.textContent.trim();
      const file = S.files.get(f.id);
      if (file) {
        file.alias = newAlias;
        DB.saveFile(file);
        renderSidebar();
      }
      fb.textContent = truncName(newAlias || file.name);
    });
    fb.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        fb.blur();
      }
    });
  }

  d.addEventListener('click', e => selPage(item.id, e));
  d.addEventListener('dblclick', e => {
    if (!e.target.closest('button') && !e.target.classList.contains('fb')) Viewer.open(item.id);
  });
  // Feature 11: right-click context menu
  d.addEventListener('contextmenu', e => {
    if (e.target.classList.contains('fb')) return;
    e.preventDefault();
    e.stopPropagation();
    ContextMenu.show(item.id, e.clientX, e.clientY);
  });
  return d;
}

function makeRow(item, f, idx) {
  const d = document.createElement('div');
  d.className = 'pr lv-cols' + (S.sel.has(item.id) ? ' sel' : '');
  d.dataset.id = item.id;

  const is3D = item.type === '3d';
  
  const selArr = [...S.sel];
  const selIdx = selArr.indexOf(item.id);
  const badgeText = selIdx >= 0 ? selIdx + 1 : '';
  const sz   = is3D
    ? `3D (${(f.ext || '').toUpperCase()})`
    : item.pw ? `${Math.round(item.pw / 2.835)}×${Math.round(item.ph / 2.835)}mm` : '−';

  const dispName = f.alias || f.name;
  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  const memoIcon = item.memo ? `<i class="fa-solid fa-note-sticky pr-memo-icon" title="${escHtml(item.memo)}"></i>` : '';

  const badges = [];
  if (item.cropBox) badges.push(`<i class="fa-solid fa-crop-simple" title="クロップ適用中"></i>`);
  if (item.scanFixData) badges.push(`<i class="fa-solid fa-object-ungroup" title="スキャン補正適用中"></i>`);
  if (item.paintData) badges.push(`<i class="fa-solid fa-paintbrush" title="ペイント適用中"></i>`);
  if (item.filters && getFilterString(item.filters) !== 'none') badges.push(`<i class="fa-solid fa-sliders" title="画像調整適用中"></i>`);
  if (item.flipH || item.flipV) badges.push(`<i class="fa-solid fa-left-right" title="反転適用中"></i>`);
  if (item.textContent) badges.push(`<i class="fa-solid fa-language" title="テキスト抽出済み"></i>`);
  if (item.has3D) badges.push(`<i class="fa-solid fa-cube" title="3Dデータを含む"></i>`);
  const statusIcons = badges.length ? `<span class="pr-status-icons" style="display:inline-flex; gap:5px; margin-left:8px; color:var(--c-t3); font-size:10px;">${badges.join('')}</span>` : '';

  d.innerHTML = `
    <div class="pr-sel-badge">${badgeText}</div>
    <span class="pr-grip"><i class="fa-solid fa-grip-dots-vertical"></i></span>
    <span class="pr-num">${idx + 1}</span>
    <span class="pr-name" title="ダブルクリックで名前を編集">${dispName}${memoIcon}${statusIcons}</span>
    <span class="pr-sz" title="クリックでmm/pt切替" data-mm="${item.pw ? Math.round(item.pw / 2.835) + '×' + Math.round(item.ph / 2.835) + 'mm' : '−'}" data-pt="${item.pw ? Math.round(item.pw) + '×' + Math.round(item.ph) + 'pt' : '−'}">${sz}</span>
    <span class="pr-rot">${item.rotation ? item.rotation + '°' : '−'}</span>
    <div class="pr-acts">
      <button class="pr-act memo" title="メモを編集"
        onclick="event.stopPropagation();editMemo('${item.id}')">
        <i class="fa-solid fa-pen-to-square"></i></button>
      ${!is3D ? `
      <button class="pr-act rot" title="左回転"
        onclick="event.stopPropagation();rotatePage('${item.id}',-90)">
        <i class="fa-solid fa-rotate-left"></i></button>
      <button class="pr-act rot" title="右回転"
        onclick="event.stopPropagation();rotatePage('${item.id}',90)">
        <i class="fa-solid fa-rotate-right"></i></button>` : ''}
      <button class="pr-act del" title="削除"
        onclick="event.stopPropagation();delPage('${item.id}')">
        <i class="fa-solid fa-xmark"></i></button>
      <button class="pr-act eye" title="拡大プレビュー [ダブルクリックも可]">
        <i class="fa-solid fa-eye"></i></button>
    </div>`;

  const prName = d.querySelector('.pr-name');
  if (prName) {
    prName.addEventListener('dblclick', e => {
      e.stopPropagation();
      prName.contentEditable = true;
      prName.focus();
      const range = document.createRange();
      range.selectNodeContents(prName);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    prName.addEventListener('blur', () => {
      prName.contentEditable = false;
      const newAlias = prName.textContent.trim();
      const file = S.files.get(f.id);
      if (file) {
        file.alias = newAlias;
        DB.saveFile(file);
        renderSidebar();
      }
      prName.textContent = newAlias || file.name;
    });
    prName.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        prName.blur();
      }
    });
  }

  const szEl = d.querySelector('.pr-sz');
  if (szEl && !is3D) {
    szEl.style.cursor = 'pointer';
    szEl.addEventListener('click', e => {
      e.stopPropagation();
      const isMm = szEl.textContent.includes('mm');
      szEl.textContent = isMm ? szEl.dataset.pt : szEl.dataset.mm;
    });
  }

  d.querySelector('.pr-act.eye').addEventListener('click', e => {
    e.stopPropagation();
    Viewer.open(item.id);
  });

  d.addEventListener('click', e => selPage(item.id, e));
  d.addEventListener('dblclick', e => {
    if (!e.target.closest('button') && !e.target.classList.contains('pr-name')) Viewer.open(item.id);
  });
  // Feature 11: right-click context menu
  d.addEventListener('contextmenu', e => {
    if (e.target.classList.contains('pr-name')) return;
    e.preventDefault();
    e.stopPropagation();
    ContextMenu.show(item.id, e.clientX, e.clientY);
  });
  return d;
}

const truncName = name => name.replace(/\.pdf$/i, '');

// ============================================================
// SORTABLE (SortableJS)
// ============================================================
function initSort(container) {
  S.sortable?.destroy();
  const isLi = S.view === 'li';
  let _originMarker = null;
  let _multiBadge   = null;

  S.sortable = new Sortable(container, {
    animation: 150,
    ghostClass:  'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass:   'sortable-drag',
    filter: 'button, .pc-acts, .pr-acts, input, textarea',
    preventOnFilter: false,
    // ダブルクリック時の誤爆を防ぐため、数ピクセル動かさないとドラッグ開始しないようにする
    delay: 0,
    delayOnTouchOnly: false,
    fallbackTolerance: 5,

    onStart: evt => {
      const el     = evt.item;
      const itemId = el.dataset.id;
      const rect   = el.getBoundingClientRect();

      _originMarker = document.createElement('div');
      _originMarker.className = 'origin-marker-fixed';
      Object.assign(_originMarker.style, {
        position:     'fixed',
        top:          rect.top    + 'px',
        left:         rect.left   + 'px',
        width:        rect.width  + 'px',
        height:       rect.height + 'px',
        zIndex:       '50',
        pointerEvents:'none',
        borderRadius: getComputedStyle(el).borderRadius,
      });
      document.body.appendChild(_originMarker);
      // Feature 13: drag insert tip
      const _tip13 = g('drag-insert-tip');
      const _tipTxt13 = g('drag-insert-tip-text');
      if (_tip13 && _tipTxt13) {
        const _dragCount = (S.sel.has(itemId) && S.sel.size > 1) ? S.sel.size : 1;
        _tipTxt13.textContent = _dragCount > 1 ? `ここに ${_dragCount} 件を挿入` : 'ここに挿入';
        _tip13.classList.add('visible');
      }
      const _onDragMove13 = (mv) => {
        const _t = g('drag-insert-tip');
        if (!_t) return;
        _t.style.left = (mv.clientX + 14) + 'px';
        _t.style.top  = (mv.clientY - 38) + 'px';
      };
      document.addEventListener('mousemove', _onDragMove13);
      evt.item._dragMoveFn = _onDragMove13;
      if (S.sel.has(itemId) && S.sel.size > 1) {
        S.sel.forEach(id => {
          if (id === itemId) return;
          const oe = container.querySelector(`[data-id="${id}"]`);
          if (oe) oe.classList.add('sortable-multi-pending');
        });
        _multiBadge = document.createElement('div');
        _multiBadge.className = 'multi-drag-badge';
        _multiBadge.innerHTML = `<i class="fa-solid fa-layer-group"></i>${S.sel.size}件`;
        el.style.position = 'relative';
        el.appendChild(_multiBadge);
      }
    },

    onEnd: evt => {
      // Feature 13: hide drag insert tip
      const _tipElEnd = g('drag-insert-tip');
      if (_tipElEnd) _tipElEnd.classList.remove('visible');
      if (evt.item._dragMoveFn) {
        document.removeEventListener('mousemove', evt.item._dragMoveFn);
        evt.item._dragMoveFn = null;
      }
      _originMarker?.remove();
      _originMarker = null;
      _multiBadge?.remove();
      _multiBadge = null;
      container.querySelectorAll('.sortable-multi-pending')
               .forEach(e => e.classList.remove('sortable-multi-pending'));

      const el     = evt.item;
      const itemId = el.dataset.id;

      const domOrder = [...container.querySelectorAll('[data-id]')].map(e => e.dataset.id);

      if (S.sel.has(itemId) && S.sel.size > 1) {
        const dropPos  = domOrder.indexOf(itemId);
        const selItems    = S.ws.filter(w =>  S.sel.has(w.id));
        const nonSelItems = S.ws.filter(w => !S.sel.has(w.id));

        let insertAt = 0;
        for (let i = 0; i < dropPos; i++) {
          if (!S.sel.has(domOrder[i])) insertAt++;
        }
        nonSelItems.splice(insertAt, 0, ...selItems);
        S.ws = nonSelItems;
      } else {
        // evt.oldIndex/newIndexに依存せず、DOMの最終順序をベースにS.wsを再構築することで、
        // リスト表示とサムネイル表示の不整合やドラッグ要素のズレを完全に防止
        S.ws = domOrder.map(id => S.ws.find(w => w.id === id));
      }

      requestAnimationFrame(() => { renderWorkspace(); saveState('ページの並び替え'); });
    },
  });
}

// ============================================================
// UI STATE SYNC
// ============================================================
function syncUI() {
  const hp = S.ws.length > 0;
  const hs = S.sel.size  > 0;
  const setD = (id, v) => { const el = g(id); if (el) el.disabled = v; };

  setD('btn-clear-all', !hp);
  setD('btn-sel-all', !hp);
  setD('btn-desel',   !hs);
  setD('btn-inv',     !hp);
  setD('btn-sel-range', !hp);
  setD('btn-undo',    S.histIdx <= 0);
  setD('btn-redo',    S.histIdx >= S.history.length - 1);
  setD('btn-compare', S.sel.size !== 2);
  setD('btn-copy',    !hs);
  setD('btn-rl',      !hs);
  setD('btn-rr',      !hs);
  setD('btn-align-v', !hs);
  setD('btn-align-h', !hs);
  setD('btn-split',   !hs);
  setD('btn-merge-h', S.sel.size < 2);
  setD('btn-merge-v', S.sel.size < 2);
  setD('btn-flip-h',  !hs);
  setD('btn-flip-v',  !hs);
  
  const isSingleSel = S.sel.size === 1;
  const isSingle3D  = isSingleSel && S.ws.find(w => w.id === [...S.sel][0])?.type === '3d';
  const canEdit = isSingleSel && !isSingle3D;
  
  setD('btn-edit-crop',    !canEdit);
  setD('btn-edit-scanfix', !canEdit);
  setD('btn-edit-paint',   !canEdit);
  setD('btn-edit-adjust',  !canEdit);

  const editTitles = {
    'btn-edit-crop': '余白トリミング（クロップ）',
    'btn-edit-scanfix': 'スキャン補正（微細回転・台形補正）',
    'btn-edit-paint': 'ペイント（描画・注釈）',
    'btn-edit-adjust': '画像調整（明るさ・コントラスト等）'
  };
  
  Object.keys(editTitles).forEach(id => {
    const el = g(id);
    if (el) {
      if (!isSingleSel) {
        el.title = `${editTitles[id]} (※1ページ選択時のみ有効)`;
      } else if (isSingle3D) {
        el.title = `${editTitles[id]} (※3Dデータでは無効)`;
      } else {
        el.title = `${editTitles[id]} (クリックでビューワーを開いて編集)`;
      }
    }
  });

  setD('btn-del',     !hs);
  setD('btn-ocr',     !hs);
  setD('btn-ocr-all', !hp);
  setD('btn-exp-sel', !hs);
  setD('btn-exp-all', !hp);
  setD('btn-exp-zip', !hs);
  setD('btn-print-sel', !hs);
  setD('btn-print-all', !hp);
  updateStat();
}

function updateStat() {
  const activeFileIds = new Set(S.ws.map(w => w.fileId));
  g('st-pages').innerHTML = `<i class="fa-solid fa-file"></i>${S.ws.length} ページ`;
  g('st-files').innerHTML = `<i class="fa-solid fa-folder"></i>${activeFileIds.size} ファイル`;
  g('st-sel').innerHTML   = `<i class="fa-regular fa-square-check"></i>${S.sel.size} 選択中`;
}

function checkEmpty() {
  g('drop-zone').classList.toggle('hidden', S.ws.length > 0);
}

function showProg(cur, tot, txt = '読み込み中') {
  const el = g('st-prog');
  el.style.display = 'flex';
  g('prog-fill').style.width = tot ? (cur / tot * 100) + '%' : '0%';
  g('prog-txt').textContent  = `${txt} (${cur} / ${tot})`;
}
function hideProg() { g('st-prog').style.display = 'none'; }

function setView(mode) {
  if (S.view === mode) return;
  S.view = mode;
  g('vbtn-th').classList.toggle('on', mode === 'th');
  g('vbtn-li').classList.toggle('on', mode === 'li');
  g('size-ctrl').classList.toggle('hidden', mode !== 'th');
  g('size-sep').classList.toggle('hidden', mode !== 'th');
  document.querySelectorAll('.th-fit-ctrl').forEach(el => el.classList.toggle('hidden', mode !== 'th'));
  renderWorkspace();
}

// ============================================================
// EVENT HANDLERS
// ============================================================
function initEvents() {
  const fi = g('file-input');

  fi.addEventListener('change', e => { loadFiles(e.target.files); fi.value = ''; });
  g('btn-add').addEventListener('click', () => fi.click());

  g('vbtn-th').addEventListener('click', () => setView('th'));
  g('vbtn-li').addEventListener('click', () => setView('li'));

  const tEnc = g('meta-encrypt');
  const pwF  = g('pw-fields');
  if (tEnc && pwF) {
    tEnc.addEventListener('change', e => {
      pwF.classList.toggle('hidden', !e.target.checked);
    });
  }

  const tPageno = g('meta-pageno');
  const pagenoF = g('pageno-fields');
  if (tPageno && pagenoF) {
    tPageno.addEventListener('change', e => {
      pagenoF.classList.toggle('hidden', !e.target.checked);
    });
  }

  const tUni = g('meta-uniform-a4');
  const uniF = g('uniform-size-fields');
  if (tUni && uniF) {
    tUni.addEventListener('change', e => {
      uniF.classList.toggle('hidden', !e.target.checked);
    });
  }

  const tText = g('meta-include-text');
  const textF = g('text-reflect-fields');
  const textModeSel = g('text-reflect-mode');
  const textModeDesc = g('text-reflect-desc');
  if (tText && textF) {
    tText.addEventListener('change', e => {
      textF.classList.toggle('hidden', !e.target.checked);
    });
  }
  if (textModeSel && textModeDesc) {
    textModeSel.addEventListener('change', e => {
      if (e.target.value === 'transparent') {
        textModeDesc.innerHTML = '見た目を保ったまま、検索やコピー用のテキストデータとして埋め込みます。<br>※元の文字との重複を防ぐため、各ページが自動的に画像化されます。';
      } else if (e.target.value === 'replace') {
        textModeDesc.innerHTML = '元のページ画像やレイアウトを破棄し、白紙にテキストのみを書き出します。';
      } else if (e.target.value === 'overlay') {
        textModeDesc.innerHTML = '元のページ画像全体を白く薄く塗りつぶし、その上に編集したテキストを可視文字として描画します。校正内容の確認等に便利です。<br>※各ページが自動的に画像化されます。';
      }
    });
  }

  const tComp = g('meta-compress');
  const compF = g('compress-fields');
  if (tComp && compF) {
    tComp.addEventListener('change', e => {
      compF.classList.toggle('hidden', !e.target.checked);
    });
  }

  const tMask = g('meta-masking');
  const maskF = g('masking-fields');
  if (tMask && maskF) {
    tMask.addEventListener('change', e => {
      maskF.classList.toggle('hidden', !e.target.checked);
    });
  }

  // 処理レシピ(マクロ)のイベント
  const recipeSel = g('recipe-sel');
  const btnApplyRecipe = g('btn-apply-recipe');
  if (recipeSel && btnApplyRecipe) {
    recipeSel.addEventListener('change', e => {
      btnApplyRecipe.disabled = !e.target.value;
    });
    btnApplyRecipe.addEventListener('click', async () => {
      const recipe = recipeSel.value;
      if (!recipe) return;
      if (recipe === 'scan_std') {
        if (confirm('全ページに対して「自動傾き補正」と「OCR」を実行します。\n（処理には少し時間がかかります）\nよろしいですか？')) {
          await MacroRunner.runScanStd();
        }
      } else if (recipe === 'redact_safe') {
        await MacroRunner.runRedactSafe();
      } else if (recipe === 'print_ready') {
        await MacroRunner.runPrintReady();
      }
    });
  }

  const cSlider = g('compress-slider');
  const cVal    = g('compress-val');
  if (cSlider && cVal) {
    cSlider.addEventListener('input', e => {
      cVal.textContent = parseFloat(e.target.value).toFixed(1);
    });
  }

  g('size-slider').addEventListener('input', e => setCardSize(Number(e.target.value)));
  g('btn-th-fit-100')?.addEventListener('click', () => applyThumbnailFit('100'));
  g('btn-th-fit-w')?.addEventListener('click', () => applyThumbnailFit('w'));
  g('btn-th-fit-h')?.addEventListener('click', () => applyThumbnailFit('h'));

  g('btn-sel-all').addEventListener('click', selAll);
  g('btn-desel').addEventListener('click', deselAll);
  g('btn-inv').addEventListener('click', invSel);

  g('btn-undo').addEventListener('click', undo);
  g('btn-redo').addEventListener('click', redo);

  g('btn-add-blank')?.addEventListener('click', addBlankPage);

  // テーマ切り替え
  const btnTheme = g('btn-toggle-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('theme-dark');
      localStorage.setItem('pdf_studio_theme', isDark ? 'dark' : 'light');
      btnTheme.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    });
  }

  // バージョン表示・更新履歴ドロップダウン
  const verBadge = g('app-version');
  const verDd = g('version-dropdown');
  if (verBadge) verBadge.textContent = 'v' + APP_VERSION;
  if (verBadge && verDd) {
    // ツールバーの隠れ防止のためbody直下に移動させる
    if (verDd.parentElement !== document.body) {
      document.body.appendChild(verDd);
    }

    const renderChangelog = () => {
      verDd.innerHTML = `<div class="ver-dd-hd">更新履歴</div>` + CHANGELOG.map(entry => `
        <div class="ver-dd-entry">
          <div class="ver-dd-entry-hd">
            <span class="ver-dd-num${entry.version === APP_VERSION ? ' current' : ''}">v${entry.version}</span>
            <span class="ver-dd-date">${entry.date}</span>
          </div>
          <ul class="ver-dd-notes">${entry.notes.map(n => `<li>${n}</li>`).join('')}</ul>
        </div>
      `).join('');
    };

    verBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = verDd.classList.contains('hidden');

      if (isHidden) {
        const rect = verBadge.getBoundingClientRect();
        verDd.style.top = (rect.bottom + 6) + 'px';

        let left = rect.left;
        if (left < 10) left = 10;
        if (left + 300 > window.innerWidth) left = window.innerWidth - 310;
        verDd.style.left = left + 'px';

        renderChangelog();
      }

      verDd.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!verBadge.contains(e.target) && !verDd.contains(e.target)) {
        verDd.classList.add('hidden');
      }
    });

    window.addEventListener('resize', () => verDd.classList.add('hidden'));
  }

  // 履歴ドロップダウン
  const btnHist = g('btn-history');
  const histDd = g('hist-dropdown');
  if (btnHist && histDd) {
    // ツールバーの隠れ防止のためbody直下に移動させる
    if (histDd.parentElement !== document.body) {
      document.body.appendChild(histDd);
    }

    btnHist.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = histDd.classList.contains('hidden');
      
      if (isHidden) {
        // 表示直前にボタンの位置を計算してドロップダウンを配置
        const rect = btnHist.getBoundingClientRect();
        histDd.style.top = (rect.bottom + 6) + 'px';
        
        // 中央揃え (ボタンの中心 - ドロップダウン幅の半分)
        let left = rect.left + (rect.width / 2) - 120;
        
        // 画面外にはみ出さないようセーフエリア調整
        if (left < 10) left = 10;
        if (left + 240 > window.innerWidth) left = window.innerWidth - 250;
        
        histDd.style.left = left + 'px';
      }
      
      histDd.classList.toggle('hidden');
      if (!histDd.classList.contains('hidden')) renderHistory();
    });

    document.addEventListener('click', (e) => {
      if (!btnHist.contains(e.target) && !histDd.contains(e.target)) {
        histDd.classList.add('hidden');
      }
    });

    // UX: ウィンドウリサイズ時や、ツールバーのスクロール時に位置ズレを防ぐため閉じる
    window.addEventListener('resize', () => histDd.classList.add('hidden'));
    document.querySelector('.tb-r2')?.addEventListener('scroll', () => histDd.classList.add('hidden'), { passive: true });
  }

  // サイドバー切り替え
  const btnSb = g('btn-toggle-sb');
  if (btnSb) {
    btnSb.addEventListener('click', () => {
      const isClosed = g('app').classList.toggle('sb-closed');
      localStorage.setItem('pdf_studio_sb_closed', isClosed ? '1' : '0');
      // サイドバー開閉アニメーション完了後にMasonryレイアウトを更新
      setTimeout(scheduleMasonry, 200);
    });
  }

  g('tb-search')?.addEventListener('input', e => filterSearch(e.target.value));
  g('btn-search-opt')?.addEventListener('click', e => {
    _searchStrict = !_searchStrict;
    e.currentTarget.classList.toggle('active', _searchStrict);
    e.currentTarget.title = _searchStrict ? "全角・半角 / 大文字・小文字を区別する (クリックで切り替え)" : "全角・半角 / 大文字・小文字を区別しない (クリックで切り替え)";
    const q = g('tb-search')?.value;
    if (q) filterSearch(q);
  });

  g('btn-compare')?.addEventListener('click', () => {
    const ids = [...S.sel];
    if (ids.length === 2) Viewer.openCompare(ids[0], ids[1]);
  });
  g('btn-copy')?.addEventListener('click', duplicateSel);
  g('btn-rl').addEventListener('click', () => rotateSel(-90));
  g('btn-rr').addEventListener('click', () => rotateSel(90));
  g('btn-align-v')?.addEventListener('click', () => alignSelectedPages('v'));
  g('btn-align-h')?.addEventListener('click', () => alignSelectedPages('h'));
  g('btn-split')?.addEventListener('click', splitSelectedPages);
  g('btn-merge-h')?.addEventListener('click', () => mergeSelectedPages('h'));
  g('btn-merge-v')?.addEventListener('click', () => mergeSelectedPages('v'));
  g('btn-flip-h')?.addEventListener('click', () => flipSel('h'));

  // 範囲選択
  g('btn-sel-range')?.addEventListener('click', () => {
    g('range-start').value = '';
    g('range-end').value = '';
    g('range-start').max = S.ws.length;
    g('range-end').max = S.ws.length;
    g('range-sel-overlay').classList.remove('hidden');
    g('range-start').focus();
  });
  
  const closeRangeSel = () => g('range-sel-overlay').classList.add('hidden');
  g('range-sel-close')?.addEventListener('click', closeRangeSel);
  g('range-sel-cancel')?.addEventListener('click', closeRangeSel);
  g('range-sel-apply')?.addEventListener('click', () => {
    let start = parseInt(g('range-start').value, 10);
    let end = parseInt(g('range-end').value, 10);
    if (isNaN(start)) start = 1;
    if (isNaN(end)) end = S.ws.length;
    
    start = Math.max(1, Math.min(start, S.ws.length));
    end = Math.max(1, Math.min(end, S.ws.length));
    
    const min = Math.min(start, end) - 1;
    const max = Math.max(start, end) - 1;
    
    S.sel.clear();
    for (let i = min; i <= max; i++) {
      S.sel.add(S.ws[i].id);
    }
    
    syncSelDOM();
    syncUI();
    closeRangeSel();
  });
  g('btn-flip-v')?.addEventListener('click', () => flipSel('v'));
  
  ['btn-edit-crop', 'btn-edit-scanfix', 'btn-edit-paint', 'btn-edit-adjust'].forEach(id => {
    g(id)?.addEventListener('click', () => {
      const items = [...S.sel];
      if(items.length !== 1) return;
      Viewer.openWithTool(items[0], id.replace('btn-edit-', 'vhd-'));
    });
  });

  g('btn-del').addEventListener('click', delSel);
  
  const btnClearAll = g('btn-clear-all');
  if (btnClearAll) btnClearAll.addEventListener('click', clearAll);

  g('btn-exp-sel').addEventListener('click', expSel);
  g('btn-exp-all').addEventListener('click', expAll);
  g('btn-exp-zip')?.addEventListener('click', () => {
    const items = S.ws.filter(w => S.sel.has(w.id));
    exportZip(items);
  });

  g('btn-print-sel')?.addEventListener('click', printSel);
  g('btn-print-all')?.addEventListener('click', printAll);

  g('print-error-overlay')?.addEventListener('click', e => {
    if (e.target === g('print-error-overlay')) g('print-error-overlay').classList.add('hidden');
  });

  g('shortcuts-close')?.addEventListener('click', () => {
    g('shortcuts-overlay').classList.add('hidden');
  });
  g('shortcuts-overlay')?.addEventListener('click', e => {
    if (e.target === g('shortcuts-overlay')) g('shortcuts-overlay').classList.add('hidden');
  });

  g('page-container').addEventListener('click', e => {
    if (e.target === g('page-container') ||
        e.target === document.getElementById('sort-wrap')) deselAll();
  });

  document.addEventListener('keydown', e => {
    const printErrOverlay = g('print-error-overlay');
    if (printErrOverlay && !printErrOverlay.classList.contains('hidden')) {
      if (e.key === 'Escape') printErrOverlay.classList.add('hidden');
      return;
    }

    const ocrOverlay = g('ocr-overlay');
    if (ocrOverlay && !ocrOverlay.classList.contains('hidden')) {
      if (e.key === 'Escape') ocrOverlay.classList.add('hidden');
      return;
    }

    const shortcutsOverlay = g('shortcuts-overlay');
    if (shortcutsOverlay && !shortcutsOverlay.classList.contains('hidden')) {
      if (e.key === 'Escape') shortcutsOverlay.classList.add('hidden');
      return;
    }
    
    if (e.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      if (shortcutsOverlay) shortcutsOverlay.classList.remove('hidden');
      return;
    }
    
    if (Viewer.isOpen) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); Viewer.navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); Viewer.navigate(1); }
      if (e.key === 'PageUp')     { e.preventDefault(); Viewer.navigate(-1); }
      if (e.key === 'PageDown')   { e.preventDefault(); Viewer.navigate(1); }
      if (e.key === 'Home')       { e.preventDefault(); Viewer.navigate(-9999); }
      if (e.key === 'End')        { e.preventDefault(); Viewer.navigate(9999); }
      if (e.key === '1') { e.preventDefault(); g('vhd-view-single')?.click(); }
      if (e.key === '2') { e.preventDefault(); g('vhd-view-double')?.click(); }
      if (e.key === '3') { e.preventDefault(); g('vhd-view-scroll')?.click(); }
      if (e.key === 'Escape')     { Viewer.close(); }
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); undo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
      e.preventDefault(); redo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault(); duplicateSel(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); g('tb-search')?.focus(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      if (S.sel.size) printSel(); else printAll();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel.size) { e.preventDefault(); delSel(); } }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a')  { e.preventDefault(); selAll(); }
    if (e.key === 'Escape')      deselAll();
    if (e.key === 'ArrowLeft'  && S.sel.size) { e.preventDefault(); rotateSel(-90); }
    if (e.key === 'ArrowRight' && S.sel.size) { e.preventDefault(); rotateSel(90); }
    if (e.key === 't' || e.key === 'T') setView('th');
    if (e.key === 'l' || e.key === 'L') setView('li');
  });

  const ws = g('workspace');
  const dz = g('drop-zone');
  
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fi.click();
    }
  });

  ws.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dz.classList.add('dov'); }
  });
  ws.addEventListener('dragleave', e => {
    if (!ws.contains(e.relatedTarget)) dz.classList.remove('dov');
  });
  ws.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dov');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  const sd = g('sb-drop');
  sd.addEventListener('click', () => fi.click());
  sd.addEventListener('dragover',  e => { e.preventDefault(); sd.classList.add('dov'); });
  sd.addEventListener('dragleave', () => sd.classList.remove('dov'));
  sd.addEventListener('drop', e => {
    e.preventDefault(); sd.classList.remove('dov');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  // ── Ctrl+V 画像貼り付け ──────────────────────────────────
  document.addEventListener('paste', e => {
    // フォーム要素またはモーダルが開いている場合はスキップ
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const modalIds = ['ocr-overlay', 'viewer-overlay', 'props-overlay', 'welcome-overlay'];
    if (modalIds.some(id => !g(id)?.classList.contains('hidden'))) return;

    const imageFiles = [];
    const SUPPORTED = ['image/jpeg', 'image/png'];
    for (const item of e.clipboardData.items) {
      if (item.kind !== 'file' || !SUPPORTED.includes(item.type)) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext  = item.type.includes('png') ? 'png' : 'jpg';
      const name = `clipboard_${Date.now()}_${imageFiles.length + 1}.${ext}`;
      imageFiles.push(new File([blob], name, { type: item.type }));
    }
    if (imageFiles.length) {
      e.preventDefault();
      loadFiles(imageFiles);
    }
  });
}

// ============================================================
// DOCUMENT PROPERTIES
// ============================================================
const DocProps = (() => {

  function open(fileId) {
    const overlay = g('props-overlay');
    const body    = g('props-body');
    if (!overlay || !body) return;

    body.innerHTML = `<div class="props-loading"><i class="fa-solid fa-spinner"></i><span>読み込み中...</span></div>`;
    overlay.classList.remove('hidden');

    const f     = S.files.get(fileId);
    const jsDoc = S.jsDocs.get(fileId);
    if (!f) return;

    // 3D ファイルは PDF メタデータがないため簡易表示
    if (f.fileType === '3d') {
      const formatBytes = n => n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
      body.innerHTML = `<table class="props-table"><tbody>
        <tr><th><i class="fa-solid fa-file"></i>ファイル名</th><td>${f.name}</td></tr>
        <tr><th><i class="fa-solid fa-weight-scale"></i>ファイルサイズ</th><td>${formatBytes(f.data.byteLength)}</td></tr>
        <tr><th><i class="fa-solid fa-cube"></i>フォーマット</th><td>${(f.ext || '').toUpperCase()} (3D)</td></tr>
      </tbody></table>`;
      return;
    }

    if (!jsDoc) return;

    jsDoc.getMetadata().then(({ info }) => {
      const rows = [
        { label: 'ファイル名',       icon: 'fa-file-pdf',    value: f.name },
        { label: 'ファイルサイズ',   icon: 'fa-weight-scale', value: formatBytes(f.data.byteLength) },
        { label: 'ページ数',         icon: 'fa-book-open',   value: `${f.pageCount} ページ` },
        { label: 'PDFバージョン',    icon: 'fa-tag',         value: info.PDFFormatVersion || '−' },
        null,
        { label: 'タイトル',         icon: 'fa-heading',     value: info.Title    || '−' },
        { label: '作成者',           icon: 'fa-user',        value: info.Author   || '−' },
        { label: 'サブジェクト',     icon: 'fa-layer-group', value: info.Subject  || '−' },
        { label: 'キーワード',       icon: 'fa-tags',        value: info.Keywords || '−' },
        null,
        { label: 'アプリケーション', icon: 'fa-pen-nib',     value: info.Creator  || '−' },
        { label: 'PDFプロデューサ',  icon: 'fa-industry',    value: info.Producer || '−' },
        null,
        { label: '作成日時',         icon: 'fa-calendar-plus',  value: formatDate(info.CreationDate) },
        { label: '更新日時',         icon: 'fa-calendar-check', value: formatDate(info.ModDate) },
      ];

      body.innerHTML = `<table class="props-table"><tbody>
        ${rows.map(r => r === null
          ? `<tr class="props-sep-row"><td colspan="2"></td></tr>`
          : `<tr>
               <th><i class="fa-solid ${r.icon}"></i>${r.label}</th>
               <td>${escHtml(String(r.value))}</td>
             </tr>`
        ).join('')}
      </tbody></table>`;
    }).catch(() => {
      body.innerHTML = `<div class="props-loading err">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>プロパティを取得できませんでした</span></div>`;
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatDate(raw) {
    if (!raw) return '−';
    try {
      const m = raw.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (m) {
        const [, y, mo, d, h, mi, s] = m;
        return `${y}/${mo}/${d}  ${h}:${mi}:${s}`;
      }
      return raw;
    } catch { return raw; }
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setupEvents() {
    g('props-close')?.addEventListener('click', () => g('props-overlay').classList.add('hidden'));
    g('props-overlay')?.addEventListener('click', e => {
      if (e.target === g('props-overlay')) g('props-overlay').classList.add('hidden');
    });
  }

  return { open, setupEvents };
})();

// ============================================================
// IMAGE UTILS (ScanFix & Macros)
// ============================================================
const ImageUtils = (() => {
  function autoDetectAngle(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const sampleScale = Math.min(1, 400 / Math.max(w, h));
    const sw = Math.round(w * sampleScale), sh = Math.round(h * sampleScale);
    
    const scCnv = document.createElement('canvas');
    scCnv.width = sw; scCnv.height = sh;
    scCnv.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
    
    const imgData = scCnv.getContext('2d').getImageData(0, 0, sw, sh);
    const data = imgData.data;
    
    const gray = new Uint8Array(sw * sh);
    for(let i=0; i<data.length; i+=4) {
      gray[i/4] = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
    }
    
    const bins = new Int32Array(1800);
    for(let y=1; y<sh-1; y++) {
      for(let x=1; x<sw-1; x++) {
        const idx = y*sw + x;
        const gx = -gray[idx-sw-1] + gray[idx-sw+1]
                   -2*gray[idx-1]   + 2*gray[idx+1]
                   -gray[idx+sw-1] + gray[idx+sw+1];
        const gy = -gray[idx-sw-1] - 2*gray[idx-sw] - gray[idx-sw+1]
                   +gray[idx+sw-1] + 2*gray[idx+sw] + gray[idx+sw+1];
        
        const mag = Math.abs(gx) + Math.abs(gy);
        if (mag > 100) {
          let angle = Math.atan2(gy, gx) * 180 / Math.PI;
          let skew = angle > 0 ? angle - 90 : angle + 90;
          if (skew > 45) skew -= 90;
          if (skew < -45) skew += 90;
          
          if (skew >= -45 && skew <= 45) {
            const binIdx = Math.floor((skew + 45) * 20);
            if(binIdx >= 0 && binIdx < bins.length) bins[binIdx] += mag;
          }
        }
      }
    }
    
    let maxBin = -1, maxVal = -1;
    for(let i=0; i<bins.length; i++) {
      const val = (bins[i-1]||0) + bins[i] + (bins[i+1]||0);
      if(val > maxVal) { maxVal = val; maxBin = i; }
    }
    if(maxBin >= 0) return (maxBin / 20) - 45;
    return 0;
  }

  function getPerspectiveTransform(src, dst) {
    const a = [];
    for (let i = 0; i < 4; i++) {
      a.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x, dst[i].x]);
      a.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y, dst[i].y]);
    }
    for (let i = 0; i < 8; i++) {
      let pivot = i;
      for (let j = i + 1; j < 8; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
      const tmp = a[i]; a[i] = a[pivot]; a[pivot] = tmp;
      const div = a[i][i];
      for (let j = 0; j < 9; j++) a[i][j] /= div;
      for (let j = 0; j < 8; j++) {
        if (i !== j) {
          const mul = a[j][i];
          for (let k = 0; k < 9; k++) a[j][k] -= a[i][k] * mul;
        }
      }
    }
    return [a[0][8], a[1][8], a[2][8], a[3][8], a[4][8], a[5][8], a[6][8], a[7][8], 1];
  }

  function warpPerspective(srcImageData, dstWidth, dstHeight, m) {
    const dstImageData = new ImageData(dstWidth, dstHeight);
    const src = srcImageData.data;
    const dst = dstImageData.data;
    const sw = srcImageData.width;
    const sh = srcImageData.height;
    let dstIdx = 0;
    for (let y = 0; y < dstHeight; y++) {
      for (let x = 0; x < dstWidth; x++) {
        const w = m[6] * x + m[7] * y + m[8];
        const sx = (m[0] * x + m[1] * y + m[2]) / w;
        const sy = (m[3] * x + m[4] * y + m[5]) / w;
        const px = Math.floor(sx);
        const py = Math.floor(sy);
        if (px >= 0 && px < sw - 1 && py >= 0 && py < sh - 1) {
          const fx = sx - px, fy = sy - py;
          const fx1 = 1 - fx, fy1 = 1 - fy;
          const w1 = fx1 * fy1, w2 = fx * fy1, w3 = fx1 * fy, w4 = fx * fy;
          const i1 = (py * sw + px) * 4;
          const i2 = i1 + 4;
          const i3 = ((py + 1) * sw + px) * 4;
          const i4 = i3 + 4;
          for (let c = 0; c < 4; c++) {
            dst[dstIdx + c] = src[i1 + c] * w1 + src[i2 + c] * w2 + src[i3 + c] * w3 + src[i4 + c] * w4;
          }
        }
        dstIdx += 4;
      }
    }
    return dstImageData;
  }

  async function applyAutoScanFix(item) {
    const jsDoc = S.jsDocs.get(item.fileId);
    if (!jsDoc) return false;
    
    const page = await jsDoc.getPage(item.pageIndex + 1);
    const totalRot = (page.rotate + item.rotation) % 360;
    const c = document.createElement('canvas');
    if (item.scanFixData) {
      const lw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
      const lh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
      const w = (item.rotation === 90 || item.rotation === 270) ? lh : lw;
      const h = (item.rotation === 90 || item.rotation === 270) ? lw : lh;
      c.width = Math.round(w * 2.0);
      c.height = Math.round(h * 2.0);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      const img = new Image();
      img.src = item.scanFixData.dataUrl;
      await new Promise(r => { img.onload = r; });
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(item.rotation * Math.PI / 180);
      const _elw = item.scanFixData.logicalWidth  ?? item.scanFixData.width  / 2;
      const _elh = item.scanFixData.logicalHeight ?? item.scanFixData.height / 2;
      ctx.drawImage(img, -_elw * 2.0 / 2, -_elh * 2.0 / 2, _elw * 2.0, _elh * 2.0);
      ctx.restore();
    } else {
      const vp = page.getViewport({ scale: 2.0, rotation: totalRot });
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }

    // 既存の反転ロジック適用 (マクロは非UI実行なため直接オフスクリーンキャンバスを反転する)
    if (item.flipH || item.flipV) {
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const offCtx = off.getContext('2d');
      offCtx.save();
      offCtx.translate(item.flipH ? c.width : 0, item.flipV ? c.height : 0);
      offCtx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
      offCtx.drawImage(c, 0, 0);
      offCtx.restore();
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      c.getContext('2d').drawImage(off, 0, 0);
    }

    const detected = autoDetectAngle(c);
    if (Math.abs(detected) < 0.05) return true;

    const sfRot = -detected;
    const _sfRad = sfRot * Math.PI / 180;
    const _bw = c.width;
    const _bh = c.height;

    const sin = Math.abs(Math.sin(_sfRad)), cos = Math.abs(Math.cos(_sfRad));
    const _cwSf = Math.floor(_bw * cos + _bh * sin);
    const _chSf = Math.floor(_bw * sin + _bh * cos);

    const sfPts = [
      {x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}
    ];

    function sfPtToBase(sfPt) {
      const cx = sfPt.x * _cwSf;
      const cy = sfPt.y * _chSf;
      const dx = cx - _cwSf / 2;
      const dy = cy - _chSf / 2;
      return {
        x: _bw / 2 + dx * Math.cos(_sfRad) + dy * Math.sin(_sfRad),
        y: _bh / 2 - dx * Math.sin(_sfRad) + dy * Math.cos(_sfRad)
      };
    }

    const p0 = sfPtToBase(sfPts[0]);
    const p1 = sfPtToBase(sfPts[1]);
    const p2 = sfPtToBase(sfPts[2]);
    const p3 = sfPtToBase(sfPts[3]);

    const srcData = c.getContext('2d').getImageData(0, 0, _bw, _bh);

    const w1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const w2 = Math.hypot(p2.x - p3.x, p2.y - p3.y);
    const h1 = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const h2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    
    let dstW = Math.max(Math.round((w1 + w2) / 2), 10);
    let dstH = Math.max(Math.round((h1 + h2) / 2), 10);
    
    const srcPts = [p0, p1, p2, p3];
    const dstPts = [{x: 0, y: 0}, {x: dstW, y: 0}, {x: dstW, y: dstH}, {x: 0, y: dstH}];
    
    const invM = getPerspectiveTransform(dstPts, srcPts);
    const dstData = warpPerspective(srcData, dstW, dstH, invM);
    
    const outCnv = document.createElement('canvas');
    outCnv.width = dstW;
    outCnv.height = dstH;
    const outCtx = outCnv.getContext('2d');
    outCtx.fillStyle = 'white';
    outCtx.fillRect(0, 0, dstW, dstH);
    
    const tmpCnv = document.createElement('canvas');
    tmpCnv.width = dstW;
    tmpCnv.height = dstH;
    tmpCnv.getContext('2d').putImageData(dstData, 0, 0);
    outCtx.drawImage(tmpCnv, 0, 0);
    
    const _sfLogW = dstW / 2.0;
    const _sfLogH = dstH / 2.0;
    item.scanFixData = {
      dataUrl: outCnv.toDataURL('image/jpeg', 0.95),
      width: dstW,
      height: dstH,
      logicalWidth: _sfLogW,
      logicalHeight: _sfLogH
    };
    
    item.rotation = 0;
    item.pageRotate = 0;
    item.flipH = false;
    item.flipV = false;
    item.cropBox = null;
    item.naturalPw = _sfLogW;
    item.naturalPh = _sfLogH;
    item.pw = _sfLogW;
    item.ph = _sfLogH;
    
    item.thumbnail = null;
    return true;
  }

  return { autoDetectAngle, getPerspectiveTransform, warpPerspective, applyAutoScanFix };
})();

// ============================================================
// MACRO RUNNER (処理レシピ)
// ============================================================
const MacroRunner = (() => {
  function triggerChange(id) {
    const el = document.getElementById(id);
    if(el) el.dispatchEvent(new Event('change'));
  }

  async function runScanStd() {
    const items = S.ws.filter(w => w.type !== '3d');
    if (items.length > 0) {
      showProg(0, items.length, 'マクロ実行中: 自動傾き補正');
      let changed = false;
      for (let i = 0; i < items.length; i++) {
        showProg(i + 1, items.length, 'マクロ実行中: 自動傾き補正');
        await ImageUtils.applyAutoScanFix(items[i]);
        thumbQ(() => genThumb(items[i]));
        changed = true;
      }
      if (changed) {
        saveState('マクロ: 自動傾き補正');
        renderAll();
      }
    }
    
    // 出力設定の適用
    const chkUniform = document.getElementById('meta-uniform-a4');
    if(chkUniform && !chkUniform.checked) { chkUniform.checked = true; triggerChange('meta-uniform-a4'); }
    const selUni = document.getElementById('uniform-size-sel');
    if(selUni) selUni.value = 'A4';
    
    const chkGray = document.getElementById('meta-grayscale');
    if(chkGray && !chkGray.checked) { chkGray.checked = true; triggerChange('meta-grayscale'); }
    
    const chkText = document.getElementById('meta-include-text');
    if(chkText && !chkText.checked) { chkText.checked = true; triggerChange('meta-include-text'); }
    const selMode = document.getElementById('text-reflect-mode');
    if(selMode) { selMode.value = 'transparent'; triggerChange('text-reflect-mode'); }
    
    if (items.length > 0) {
      hideProg();
      // 全ページのOCRを起動する (OCRパネルが表示されます)
      document.getElementById('btn-ocr-all')?.click();
    }
  }

  async function runRedactSafe() {
    const chkMask = document.getElementById('meta-masking');
    if(chkMask && !chkMask.checked) { chkMask.checked = true; triggerChange('meta-masking'); }
    const chkComp = document.getElementById('meta-compress');
    if(chkComp && !chkComp.checked) { chkComp.checked = true; triggerChange('meta-compress'); }
    const chkUniform = document.getElementById('meta-uniform-a4');
    if(chkUniform && !chkUniform.checked) { chkUniform.checked = true; triggerChange('meta-uniform-a4'); }
    const selUni = document.getElementById('uniform-size-sel');
    if(selUni) selUni.value = 'A4';
    const compSlider = document.getElementById('compress-slider');
    if (compSlider) { compSlider.value = 0.6; triggerChange('compress-slider'); }
    
    alert('設定を「セキュア共有」用に変更しました。\nヘッダーの「全て保存」からエクスポートしてください。');
  }

  async function runPrintReady() {
    const chkUniform = document.getElementById('meta-uniform-a4');
    if(chkUniform && !chkUniform.checked) { chkUniform.checked = true; triggerChange('meta-uniform-a4'); }
    const selUni = document.getElementById('uniform-size-sel');
    if(selUni) selUni.value = 'A4';
    
    const chkGray = document.getElementById('meta-grayscale');
    if(chkGray && !chkGray.checked) { chkGray.checked = true; triggerChange('meta-grayscale'); }
    
    const chkPageNo = document.getElementById('meta-pageno');
    if(chkPageNo && !chkPageNo.checked) { chkPageNo.checked = true; triggerChange('meta-pageno'); }
    const pos = document.getElementById('pageno-pos');
    if(pos) pos.value = 'bottom-center';
    
    alert('設定を「印刷用」に変更しました。\nヘッダーの「全て保存」からエクスポートしてください。');
  }

  return { runScanStd, runRedactSafe, runPrintReady };
})();

// ============================================================
// OCR (Tesseract.js) — テキスト層優先 / 画像ページのみOCR
// ============================================================
const OCR = (() => {
  let worker   = null;
  let _items   = [];    // 処理対象ページ一覧
  let _results = [];    // [{ item, text, source, pageNum }]
  let _viewIdx = 0;
  let _preferText = false;   // テキスト層優先モード（OFFが既定: 全ページTesseract実行）
  // プレビュー非同期レンダリングキャンセル用
  let _prevToken = 0;

  async function initWorker() {
    worker = await OCRWorker.get();
  }

  // ── ソースバッジ更新 ──────────────────────────────────────
  function updateSrcBadge(idx) {
    const badge = g('ocr-src-badge');
    if (!badge) return;
    const r = _results[idx];
    if (!r || r.source === 'pending') {
      badge.classList.add('hidden');
      return;
    }
    badge.classList.remove('hidden', 'src-text', 'src-ocr');
    if (r.source === 'text') {
      badge.classList.add('src-text');
      badge.innerHTML = '<i class="fa-solid fa-font"></i>テキスト抽出';
    } else if (r.source === 'ocr') {
      badge.classList.add('src-ocr');
      badge.innerHTML = '<i class="fa-solid fa-language"></i>OCR認識';
    }
  }

  // ── プレビューレンダリング ──────────────────────────────────
  async function renderPreview(item) {
    const token  = ++_prevToken;
    const canvas = g('ocr-prev-canvas');
    const ld     = g('ocr-prev-ld');
    if (!canvas || !ld) return;

    canvas.style.display = 'none';
    ld.style.display     = 'flex';

    const jsDoc = S.jsDocs.get(item.fileId);
    if (!jsDoc) { ld.style.display = 'none'; return; }

    try {
      const page     = await jsDoc.getPage(item.pageIndex + 1);
      if (token !== _prevToken) return;

      const dpr      = Math.min(window.devicePixelRatio || 1, 2);
      const totalRot = (page.rotate + item.rotation) % 360;
      const vp0      = page.getViewport({ scale: 1, rotation: totalRot });

      const wrap  = g('ocr-prev-wrap');
      const maxW  = (wrap.clientWidth  || 400) - 24;
      const maxH  = (wrap.clientHeight || 500) - 24;
      const scale = Math.min(maxW / vp0.width, maxH / vp0.height, 3) * dpr;
      const vp    = page.getViewport({ scale, rotation: totalRot });

      canvas.width        = Math.round(vp.width);
      canvas.height       = Math.round(vp.height);
      canvas.style.width  = Math.round(vp.width  / dpr) + 'px';
      canvas.style.height = Math.round(vp.height / dpr) + 'px';

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      if (token !== _prevToken) return;
      ld.style.display     = 'none';
      canvas.style.display = 'block';
    } catch {
      if (token !== _prevToken) return;
      ld.style.display = 'none';
    }
  }

  // ── ページナビゲーション ──────────────────────────────────
  function updateNav() {
    const total = _items.length;
    const pager = g('ocr-pager');
    if (pager) pager.textContent = total > 0 ? `${_viewIdx + 1} / ${total}` : '−';
    const prev = g('ocr-nav-prev');
    const next = g('ocr-nav-next');
    if (prev) prev.disabled = _viewIdx <= 0;
    if (next) next.disabled = _viewIdx >= total - 1;
    updateSrcBadge(_viewIdx);
  }

  function navigateTo(idx) {
    if (idx < 0 || idx >= _items.length) return;
    _viewIdx = idx;
    updateNav();
    renderPreview(_items[idx]);
    const ta = g('ocr-textarea');
    const taOrig = g('ocr-orig-textarea');
    if (ta && _results[idx]?.text) {
      const marker = `--- ページ ${idx + 1}`;
      const scrollToMarker = (textArea) => {
        if (!textArea) return;
        const lines  = textArea.value.split('\n');
        const lineIdx = lines.findIndex(l => l.startsWith(marker));
        if (lineIdx >= 0) {
          const charPos = lines.slice(0, lineIdx).join('\n').length;
          textArea.setSelectionRange(charPos, charPos);
          textArea.focus();
        }
      };
      scrollToMarker(ta);
      scrollToMarker(taOrig);
    }
  }

  // ── OCR実行（選択ページ群） ──────────────────────────────
  async function runForSelected() {
    _items = S.ws.filter(w => S.sel.has(w.id) && w.type !== '3d');
    if (!_items.length) return;
    await _run(_items);
  }

  // ── OCR実行（全ページ） ────────────────────────────────
  async function runForAll() {
    _items = S.ws.filter(w => w.type !== '3d');
    if (!_items.length) return;
    await _run(_items);
  }

  // ── OCR実行（ビューワーから単一ページ指定） ─────────────
  async function runForItem(item) {
    _items = [item];
    await _run(_items);
  }

  // ── OCR / テキスト抽出 共通コア ──────────────────────────
  // 2フェーズ処理:
  //   Phase 1: 全ページに対してテキスト層を検査し、有意テキストは即時抽出
  //   Phase 2: 画像のみのページに対してのみ Tesseract OCR を実行
  async function _run(items) {
    _items   = items;
    _results = _items.map((item, i) => ({
      item,
      text:    '',
      source:  'pending',  // 'text' | 'ocr' | 'pending'
      pageNum: i + 1,
    }));
    _viewIdx = 0;

    const ta = g('ocr-textarea');
    const taOrig = g('ocr-orig-textarea');
    const st = g('ocr-status');
    if (ta) ta.value = '';
    if (taOrig) taOrig.value = '';
    if (st) st.textContent = '';

    // バッジを初期化
    const badge = g('ocr-src-badge');
    if (badge) badge.classList.add('hidden');

    g('ocr-overlay').classList.remove('hidden');
    updateNav();

    try {
      // ── Phase 1: テキスト層の検査・抽出 ─────────────────────
      showProg(0, _items.length, _preferText ? 'テキスト解析中' : 'OCR処理準備中');
      let needOCR = false;

      for (let i = 0; i < _items.length; i++) {
        showProg(i + 1, _items.length, _preferText ? 'テキスト解析中' : 'OCR処理準備中');

        // テキスト層優先モードでない場合（既定）: 全ページをOCR対象に
        if (!_preferText) {
          _results[i].source = 'ocr';
          needOCR = true;
          continue;
        }

        // テキスト層優先モード: テキスト層を検査して抽出
        const item  = _items[i];
        const jsDoc = S.jsDocs.get(item.fileId);
        if (!jsDoc) { _results[i].source = 'ocr'; needOCR = true; continue; }

        const page = await jsDoc.getPage(item.pageIndex + 1);
        const tc   = await page.getTextContent();
        const raw  = tc.items.map(it => it.str).join('');
        const isTextPage = raw.replace(/\s+/g, '').length >= TEXT_LAYER_THRESHOLD;

        if (isTextPage) {
          // テキスト層から整形して抽出
          _results[i].text   = await extractPageText(page);
          _results[i].source = 'text';
        } else {
          // 画像ページ → Phase 2 でOCR対象
          _results[i].source = 'ocr';
          needOCR = true;
        }
      }

      // Phase 1 完了時点で初期テキストを保持
      for (let i = 0; i < _items.length; i++) {
        if (_results[i].source === 'text') {
          _results[i].originalText = _results[i].text;
          _items[i].textContent = _results[i].text;
          patchThumbDOM(_items[i]);
        }
      }
      // Phase 1 完了時点でテキスト抽出済みページをテキストエリアに反映
      if (ta) {
        const fullOriginal = buildFullText(true);
        if (taOrig) taOrig.value = fullOriginal;
        ta.value = buildFullText(false);
        updateHighlight(fullOriginal, ta.value);
      }
      // 最初のページのバッジを更新
      updateSrcBadge(0);

      // ── Phase 2: 画像ページの OCR 処理 ──────────────────────
      if (needOCR) {
        await initWorker();

        for (let i = 0; i < _items.length; i++) {
          if (_results[i].source !== 'ocr') continue;  // テキスト抽出済みはスキップ

          const item  = _items[i];
          _viewIdx = i;
          updateNav();

          // renderPreview を await することで、同一 page オブジェクトへの
          // 並行 render() を防ぐ（PDF.js は同一ページの並行レンダリング不可）
          await renderPreview(item);

          showProg(i + 1, _items.length, 'OCR認識中');

          const jsDoc = S.jsDocs.get(item.fileId);
          if (!jsDoc) continue;

          const page     = await jsDoc.getPage(item.pageIndex + 1);
          const totalRot = (page.rotate + item.rotation) % 360;
          const vp       = page.getViewport({ scale: 3.0, rotation: totalRot });
          const cnv      = document.createElement('canvas');
          cnv.width  = Math.round(vp.width);
          cnv.height = Math.round(vp.height);
          await page.render({ canvasContext: cnv.getContext('2d'), viewport: vp }).promise;

          const { data: { text } } = await worker.recognize(cnv.toDataURL('image/png'));
          _results[i].text = text.trim();
          _results[i].originalText = _results[i].text;
          item.textContent = _results[i].text;
          patchThumbDOM(item);

          if (ta) {
            const fullOriginal = buildFullText(true);
            if (taOrig) taOrig.value = fullOriginal;
            ta.value = buildFullText(false);
            updateHighlight(fullOriginal, ta.value);
          }
          updateSrcBadge(i);
        }
      }

      // ── 完了サマリー ─────────────────────────────────────────
      const textCnt = _results.filter(r => r.source === 'text').length;
      const ocrCnt  = _results.filter(r => r.source === 'ocr').length;
      let summary;
      if (textCnt > 0 && ocrCnt > 0) {
        summary = `完了 — テキスト抽出: ${textCnt}p / OCR: ${ocrCnt}p`;
      } else if (ocrCnt > 0) {
        summary = `OCR完了 (${ocrCnt}ページ)`;
      } else {
        summary = `テキスト抽出完了 (${textCnt}ページ)`;
      }
      if (st) st.textContent = summary;

    } catch (err) {
      if (st) st.textContent = 'エラーが発生しました';
      alert('処理中にエラーが発生しました。\n' + err.message);
    } finally {
      hideProg();
    }
  }

  // ── テキスト結合 ─────────────────────────────────────────
  function buildFullText(useOriginal = false) {
    const multi = _items.length > 1;
    return _results
      .filter(r => r.text || r.originalText)
      .map(r => {
        const txt = useOriginal ? (r.originalText || '') : r.text;
        if (!multi) return txt;
        const srcLabel = r.source === 'text' ? '[テキスト]' : '[OCR]';
        return `--- ページ ${r.pageNum} ${srcLabel} ---\n${txt}`;
      })
      .join('\n\n');
  }

  // ── 差分ハイライトの更新 ─────────────────────────────────
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function updateHighlight(originalText, currentText) {
    const hl = g('ocr-text-hl');
    if (!hl) return;
    if (!originalText || originalText === currentText) {
      hl.innerHTML = escapeHtml(currentText || '').replace(/\n/g, '<br>');
      return;
    }
    
    const origLines = originalText.split('\n');
    const currLines = currentText.split('\n');
    
    let html = '';
    for (let i = 0; i < currLines.length; i++) {
      const cLine = currLines[i];
      const oLine = i < origLines.length ? origLines[i] : null;
      
      if (cLine === oLine) {
        html += escapeHtml(cLine) + '<br>';
      } else {
        if (oLine == null) {
          html += `<span class="edited">${escapeHtml(cLine)}</span><br>`;
        } else {
          let start = 0;
          while(start < oLine.length && start < cLine.length && oLine[start] === cLine[start]) start++;
          let endO = oLine.length - 1, endC = cLine.length - 1;
          while(endO >= start && endC >= start && oLine[endO] === cLine[endC]) { endO--; endC--; }
          const pref = cLine.substring(0, start);
          const mid  = cLine.substring(start, endC + 1);
          const suff = cLine.substring(endC + 1);
          html += escapeHtml(pref) + (mid ? `<span class="edited">${escapeHtml(mid)}</span>` : '') + escapeHtml(suff) + '<br>';
        }
      }
    }
    hl.innerHTML = html;
  }

  // ── イベント設定 ─────────────────────────────────────────
  function setupEvents() {
    g('btn-ocr').addEventListener('click', runForSelected);
    g('btn-ocr-all')?.addEventListener('click', runForAll);

    g('ocr-close').addEventListener('click', () => {
      g('ocr-overlay').classList.add('hidden');
      // テキスト層優先モードをリセット（次回起動時はOCR優先の既定モードに）
      _preferText = false;
      const ft = g('ocr-force-toggle');
      if (ft) ft.classList.remove('active');
    });
    g('ocr-nav-prev').addEventListener('click', () => navigateTo(_viewIdx - 1));
    g('ocr-nav-next').addEventListener('click', () => navigateTo(_viewIdx + 1));

    const ta = g('ocr-textarea');
    const hl = g('ocr-text-hl');
    const taOrig = g('ocr-orig-textarea');
    let isSyncingLeft = false;
    let isSyncingRight = false;

    if (ta && hl) {
      ta.addEventListener('input', () => {
        const currentText = ta.value;
        const origText = taOrig ? taOrig.value : buildFullText(true); 
        updateHighlight(origText, currentText);
      });
      ta.addEventListener('scroll', () => {
        hl.scrollTop = ta.scrollTop;
        hl.scrollLeft = ta.scrollLeft;
        if (taOrig && !isSyncingLeft) {
          isSyncingRight = true;
          taOrig.scrollTop = ta.scrollTop;
          taOrig.scrollLeft = ta.scrollLeft;
        }
        isSyncingLeft = false;
      });
      if (taOrig) {
        taOrig.addEventListener('scroll', () => {
          if (!isSyncingRight) {
            isSyncingLeft = true;
            ta.scrollTop = taOrig.scrollTop;
            ta.scrollLeft = taOrig.scrollLeft;
            hl.scrollTop = taOrig.scrollTop;
            hl.scrollLeft = taOrig.scrollLeft;
          }
          isSyncingRight = false;
        });
      }
    }

    g('btn-ocr-copy-orig')?.addEventListener('click', async () => {
      if(!taOrig || !taOrig.value) return;
      try {
        await navigator.clipboard.writeText(taOrig.value);
      } catch {
        taOrig.select();
        document.execCommand('copy');
      }
      const st = g('ocr-status');
      if (st) st.textContent = '抽出結果(オリジナル)をコピーしました';
      setTimeout(() => {
        if (g('ocr-status')?.textContent.includes('抽出結果')) g('ocr-status').textContent = '';
      }, 3000);
    });

    g('btn-ocr-revert')?.addEventListener('click', () => {
      if(!confirm('編集内容を破棄し、抽出結果で上書きしますか？')) return;
      if(!ta || !taOrig) return;
      ta.value = taOrig.value;
      updateHighlight(taOrig.value, ta.value);
      const st = g('ocr-status');
      if (st) st.textContent = 'テキストをリセットしました';
      setTimeout(() => {
        if (g('ocr-status')?.textContent.includes('リセット')) g('ocr-status').textContent = '';
      }, 3000);
    });

    g('btn-ocr-save')?.addEventListener('click', () => {
      const taArea = g('ocr-textarea');
      if (!taArea) return;
      const text = taArea.value;
      if (_items.length === 1) {
        _items[0].textContent = text;
        _results[0].originalText = text;
        _results[0].text = text;
        updateHighlight(text, text);
        if (taOrig) taOrig.value = text;
        const st = g('ocr-status');
        if (st) st.textContent = 'テキストを保存しました';
      } else {
        const lines = text.split('\n');
        let currentItemIdx = -1;
        let currentBuffer = [];
        const saveBuffer = () => {
          if (currentItemIdx >= 0 && currentItemIdx < _items.length) {
            const joined = currentBuffer.join('\n').trim();
            _items[currentItemIdx].textContent = joined;
            _results[currentItemIdx].originalText = joined;
            _results[currentItemIdx].text = joined;
          }
        };
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^--- ページ (\d+)/);
          if (m) {
            saveBuffer();
            currentItemIdx = parseInt(m[1], 10) - 1;
            currentBuffer = [];
          } else {
            if (currentItemIdx >= 0) currentBuffer.push(lines[i]);
          }
        }
        saveBuffer();
        
        const newText = buildFullText();
        taArea.value = newText;
        if (taOrig) taOrig.value = newText;
        updateHighlight(newText, newText);
        
        const st = g('ocr-status');
        if (st) st.textContent = '全ページのテキストを保存しました';
      }
      setTimeout(() => { if (g('ocr-status')?.textContent.includes('保存')) g('ocr-status').textContent = ''; }, 3000);
    });

    g('btn-ocr-copy').addEventListener('click', async () => {
      const text = g('ocr-textarea').value;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const taArea = g('ocr-textarea');
        taArea.select();
        document.execCommand('copy');
      }
      const st = g('ocr-status');
      if (st) st.textContent = 'クリップボードにコピーしました';
      setTimeout(() => {
        if (g('ocr-status')?.textContent === 'クリップボードにコピーしました')
          g('ocr-status').textContent = '';
      }, 3000);
    });

    const getOCRText = () => {
      const ta = g('ocr-textarea');
      return ta.value.substring(ta.selectionStart, ta.selectionEnd) || ta.value;
    };
    g('btn-ocr-deepl')?.addEventListener('click', () => {
      const text = getOCRText();
      if (!text) return;
      const urlTmpl = localStorage.getItem('pdf_studio_url_deepl') || 'https://www.deepl.com/ja/translator#ja/en/{text}';
      window.open(urlTmpl.replace('{text}', encodeURIComponent(text)), '_blank');
    });
    g('btn-ocr-google')?.addEventListener('click', () => {
      const text = getOCRText();
      if (!text) return;
      const urlTmpl = localStorage.getItem('pdf_studio_url_google') || 'https://translate.google.co.jp/?sl=auto&tl=ja&text={text}&op=translate';
      window.open(urlTmpl.replace('{text}', encodeURIComponent(text)), '_blank');
    });

    // 強制OCRトグル
    const forceToggle = g('ocr-force-toggle');
    if (forceToggle) {
      forceToggle.addEventListener('click', () => {
        _preferText = !_preferText;
        forceToggle.classList.toggle('active', _preferText);
        forceToggle.title = _preferText
          ? 'テキスト層優先モード ON — クリックで解除（OCRのみに戻す）'
          : 'テキスト層があるページはテキスト抽出を優先します（クリックでON）';
      });
    }

    // フォント設定（OCRテキストエリア）
    const fontSel     = g('ocr-font-sel');
    const fontSizeEl  = g('ocr-font-size');
    const fontSizeVal = g('ocr-font-size-val');

    if (fontSel && ta) {
      fontSel.addEventListener('change', () => {
        ta.style.fontFamily = fontSel.value;
        if (taOrig) taOrig.style.fontFamily = fontSel.value;
      });
    }
    if (fontSizeEl && ta && fontSizeVal) {
      fontSizeEl.addEventListener('input', () => {
        const v = fontSizeEl.value;
        ta.style.fontSize = v + 'px';
        if (taOrig) taOrig.style.fontSize = v + 'px';
        fontSizeVal.textContent = v + 'px';
      });
    }
  }

  return { setupEvents, runForItem };
})();

// ============================================================
// CONTEXT MENU  (Feature 11)
// ============================================================
const ContextMenu = (() => {
  let _closeListenersInit = false;
  function _el() { return g('ctx-menu'); }

  function _buildItems(itemId) {
    const item = S.ws.find(w => w.id === itemId);
    if (!item) return '';
    const is3D    = item.type === '3d';
    const isMulti = S.sel.has(itemId) && S.sel.size > 1;
    let html = '';
    if (isMulti) html += `<div class="ctx-header"><i class="fa-solid fa-check-double"></i>&ensp;選択中 ${S.sel.size} 件</div>`;
    html += `<div class="ctx-item" data-action="open"><i class="fa-solid fa-up-right-and-down-left-from-center"></i>開いて編集・確認</div>`;
    html += `<div class="ctx-sep"></div>`;
    if (S.sel.size === 2) {
      html += `<div class="ctx-item" data-action="compare"><i class="fa-solid fa-code-compare"></i>比較表示（2ページ）</div>`;
      html += `<div class="ctx-sep"></div>`;
    }
    if (!is3D && !isMulti) {
      html += `<div class="ctx-item" data-action="crop"><i class="fa-solid fa-crop-simple"></i>余白トリミング（クロップ）</div>`;
      html += `<div class="ctx-item" data-action="scanfix"><i class="fa-solid fa-object-ungroup"></i>スキャン補正</div>`;
      html += `<div class="ctx-item" data-action="paint"><i class="fa-solid fa-paintbrush"></i>ペイント（描画・注釈）</div>`;
      html += `<div class="ctx-item" data-action="adjust"><i class="fa-solid fa-sliders"></i>画像調整</div>`;
      html += `<div class="ctx-sep"></div>`;
    }
    html += `<div class="ctx-item" data-action="dup"><i class="fa-regular fa-copy"></i>複製</div>`;
    if (!is3D) {
      html += `<div class="ctx-item" data-action="rl"><i class="fa-solid fa-rotate-left"></i>左に 90° 回転</div>`;
      html += `<div class="ctx-item" data-action="rr"><i class="fa-solid fa-rotate-right"></i>右に 90° 回転</div>`;
      if (isMulti) {
        html += `<div class="ctx-item" data-action="align-v"><i class="fa-solid fa-up-down"></i>縦向きに統一</div>`;
        html += `<div class="ctx-item" data-action="align-h"><i class="fa-solid fa-left-right"></i>横向きに統一</div>`;
      }
      if (!isMulti) {
        html += `<div class="ctx-item" data-action="split"><i class="fa-solid fa-table-columns"></i>見開きページを分割</div>`;
      } else {
        html += `<div class="ctx-item" data-action="merge-h"><i class="fa-solid fa-object-group"></i>横に結合</div>`;
        html += `<div class="ctx-item" data-action="merge-v"><i class="fa-solid fa-layer-group"></i>縦に結合</div>`;
      }
    }
    html += `<div class="ctx-sep"></div>`;
    if (!is3D) {
      html += `<div class="ctx-item" data-action="ocr"><i class="fa-solid fa-language"></i>OCR / テキスト抽出</div>`;
      html += `<div class="ctx-sep"></div>`;
    }
    html += `<div class="ctx-item danger" data-action="del"><i class="fa-solid fa-trash-can"></i>削除</div>`;
    return html;
  }

  function show(itemId, x, y) {
    const menu = _el();
    if (!menu) return;
    if (!S.sel.has(itemId)) {
      S.sel.clear();
      S.sel.add(itemId);
      syncSelDOM();
      syncUI();
    }
    menu.innerHTML = _buildItems(itemId);
    menu.classList.add('open');
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth  - 8) menu.style.left = Math.max(4, x - r.width  - 4) + 'px';
      if (r.bottom > window.innerHeight - 8) menu.style.top  = Math.max(4, y - r.height - 4) + 'px';
    });
    menu.querySelectorAll('.ctx-item[data-action]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const action = el.dataset.action;
        hide();
        const item = S.ws.find(w => w.id === itemId);
        if      (action === 'compare') Viewer.openCompare([...S.sel][0], [...S.sel][1]);
        else if (action === 'open') Viewer.open(itemId);
        else if (action === 'crop') Viewer.openWithTool(itemId, 'vhd-crop');
        else if (action === 'scanfix') Viewer.openWithTool(itemId, 'vhd-scanfix');
        else if (action === 'paint') Viewer.openWithTool(itemId, 'vhd-paint');
        else if (action === 'adjust') Viewer.openWithTool(itemId, 'vhd-adjust');
        else if (action === 'dup')  duplicateSel();
        else if (action === 'rl')   rotateSel(-90);
        else if (action === 'rr')   rotateSel(90);
        else if (action === 'align-v') alignSelectedPages('v');
        else if (action === 'align-h') alignSelectedPages('h');
        else if (action === 'split') splitSelectedPages();
        else if (action === 'merge-h') mergeSelectedPages('h');
        else if (action === 'merge-v') mergeSelectedPages('v');
        else if (action === 'ocr')  { if (item) OCR.runForItem(item); }
        else if (action === 'del')  { S.sel.size > 1 ? delSel() : delPage(itemId); }
      });
    });
    if (!_closeListenersInit) {
      _closeListenersInit = true;
      document.addEventListener('click', e => { if (!_el()?.contains(e.target)) hide(); }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
      g('page-container')?.addEventListener('scroll', hide, { passive: true });
    }
    menu.focus();
  }

  function hide() { _el()?.classList.remove('open'); }
  return { show, hide };
})();

// ============================================================
// SESSION RESTORE HELPERS  (Feature 14)
// ============================================================
function _showSessionRestoreToast(dbFiles, dbWs, metaStr) {
  const modal = g('session-restore-modal');
  if (!modal) return;
  const metaEl = g('srm-meta');
  if (metaEl) metaEl.textContent = metaStr + ' の作業データが見つかりました';
  modal.style.display = '';
  modal.classList.add('srm-visible');
  const BAR_MS = 8000;
  const bar = g('srm-progress-bar');
  let timer = null;
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '100%';
    requestAnimationFrame(() => {
      bar.style.transition = `width ${BAR_MS}ms linear`;
      bar.style.width = '0%';
    });
  }
  timer = setTimeout(dismiss, BAR_MS);
  function dismiss() {
    clearTimeout(timer);
    modal.classList.remove('srm-visible');
    modal.classList.add('srm-hiding');
    setTimeout(() => { modal.style.display = 'none'; modal.classList.remove('srm-hiding'); }, 220);
  }
  g('srm-restore')?.addEventListener('click', async () => { dismiss(); await restoreFromDB(dbFiles, dbWs); });
  g('srm-discard')?.addEventListener('click', async () => { dismiss(); await DB.clearAll(); });
  g('srm-close')?.addEventListener('click', dismiss);
}

function initWelcome(dbFiles, dbWs) {
  const STORAGE_KEY = 'pdf_studio_welcome_seen';
  const overlay     = g('welcome-overlay');
  const hasData     = !!(dbFiles && dbFiles.length && dbWs && dbWs.length);

  function buildMeta() {
    const fc = new Set((dbWs || []).map(w => w.fileId)).size;
    return `${(dbWs || []).length} ページ・${fc} ファイル`;
  }

  // Flow B: welcome already dismissed → show toast
  const seen = localStorage.getItem(STORAGE_KEY);
  if (seen) {
    if (overlay) overlay.classList.add('hidden');
    if (hasData) _showSessionRestoreToast(dbFiles, dbWs, buildMeta());
    return;
  }

  // Flow A: welcome shown → embed restore section
  if (!overlay) return;
  if (hasData) {
    const sec  = g('wc-restore-section');
    const meta = g('wc-restore-meta');
    if (sec)  sec.style.display = '';
    if (meta) meta.textContent  = buildMeta() + ' の作業データが見つかりました。';
    g('wc-btn-restore')?.addEventListener('click', async () => { closeWelcome(false); await restoreFromDB(dbFiles, dbWs); });
    g('wc-btn-new')?.addEventListener('click',     async () => { await DB.clearAll(); closeWelcome(false); });
  }

  overlay.classList.remove('hidden');
  const startBtn  = g('wc-start');
  const noShowChk = g('wc-no-show');

  function closeWelcome(discardDb) {
    if (noShowChk?.checked) localStorage.setItem(STORAGE_KEY, '1');
    overlay.classList.add('hidden');
    if (discardDb && hasData) DB.clearAll().catch(console.error);
  }

  startBtn?.addEventListener('click', () => closeWelcome(hasData));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeWelcome(hasData); });
  document.addEventListener('keydown', function escH(e) {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
      closeWelcome(hasData);
      document.removeEventListener('keydown', escH);
    }
  });
}

// ============================================================
// INIT
// ============================================================
async function restoreFromDB(files, ws) {
  if (!files || !files.length || !ws || !ws.length) return;
  showProg(0, files.length, '前回の作業状態を復元中');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    S.files.set(f.id, f);
    if (f.fileType !== '3d') {
      try {
        const jsDoc = await pdfjsLib.getDocument({
          data: f.data.slice(0),
          cMapUrl: CMAP_URL,
          cMapPacked: CMAP_PACKED,
          standardFontDataUrl: STANDARD_FONT_DATA_URL,
          useSystemFonts: true
        }).promise;
        S.jsDocs.set(f.id, jsDoc);
      } catch (e) { console.error('PDF restore error', e); }
    }
    showProg(i + 1, files.length, '前回の作業状態を復元中');
  }
  S.ws = ws;
  ws.forEach(w => { if (!w.thumbnail) thumbQ(() => genThumb(w)); });
  hideProg();
  const need3D = new Set(S.ws.filter(w => w.has3D).map(w => w.fileId));
  need3D.forEach(fid => {
    PDF3D.detect(fid).then(anns => {
      anns.forEach(ann => {
        const item = S.ws.find(w => w.fileId === fid && w.pageIndex === ann.pageIdx);
        if (item) item.annotation3D = ann;
      });
    }).catch(() => {});
  });
  saveState(); syncUI(); checkEmpty(); renderAll();
}

async function init() {
  // テーマ状態の復元
  const savedTheme = localStorage.getItem('pdf_studio_theme');
  const isDark = savedTheme === 'dark' || (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) {
    document.body.classList.add('theme-dark');
  }
  const btnTheme = g('btn-toggle-theme');
  if (btnTheme) {
    btnTheme.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  }

  // サイドバー状態の復元
  if (localStorage.getItem('pdf_studio_sb_closed') === '1') {
    g('app').classList.add('sb-closed');
  }

  initEvents();
  Viewer.buildDOM();
  OCR.setupEvents();
  DocProps.setupEvents();
  setCardSize(CARD_SIZE_DEF);
  g('size-ctrl').classList.remove('hidden');
  g('size-sep').classList.remove('hidden');
  document.querySelectorAll('.th-fit-ctrl').forEach(el => el.classList.remove('hidden'));
  // Read DB FIRST — session restore UI needs this before initWelcome
  let _dbFiles = null, _dbWs = null;
  try {
    _dbFiles = await DB.getFiles();
    _dbWs    = await DB.getWorkspace();
  } catch (e) { console.error('DB read error', e); }
  saveState();
  syncUI();
  checkEmpty();
  renderAll();
  initWelcome(_dbFiles, _dbWs);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => scheduleMasonry()).observe(g('page-container'));
  }

  // ── サイドバータブ切替 ─────────────────────────────────────
  document.querySelectorAll('.sb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.sb-tab').forEach(t => t.classList.toggle('active', t === tab));
      g('sbp-files')   ?.classList.toggle('hidden', target !== 'files');
      g('sbp-settings')?.classList.toggle('hidden', target !== 'settings');
    });
  });
}
init();
