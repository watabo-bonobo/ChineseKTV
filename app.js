(() => {
  'use strict';

  const { pinyin } = window.pinyinPro;
  const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
  const MAX_SAVED = 200;

  // ---------- 漢字の変換表 ----------
  const pairMap = (s) => {
    const cps = [...s];
    const m = new Map();
    for (let i = 0; i + 1 < cps.length; i += 2) m.set(cps[i], cps[i + 1]);
    return m;
  };
  const T2S = pairMap(window.HANZI_MAP.t2s);
  const JP2T = pairMap(window.HANZI_MAP.jp2t);
  // 歌詞でよく出るのに文字表だけでは読みがずれる字
  const EXTRA_T2S = new Map([['妳', '你'], ['祢', '你'], ['牠', '它']]);
  const ZHU_NEXT = '名作称稱述书書';
  const ZHU_PREV = '显顯土卓名巨原编編论論专專昭';

  // 繁体字 → 簡体字（1文字ずつ。文字数は変わらない）
  function toSimplifiedChars(chars) {
    return chars.map((c, i) => {
      if (c === '著') {
        // 歌詞の「著」はほぼ「着(zhe)」。著名・显著などの zhù はそのまま
        if (ZHU_NEXT.includes(chars[i + 1] || '') || ZHU_PREV.includes(chars[i - 1] || '')) return '著';
        return '着';
      }
      return EXTRA_T2S.get(c) || T2S.get(c) || c;
    });
  }

  // 検索キーワード：そのまま簡体字化したものと、日本の新字体を中国の字に直したものの 2 通り
  function queryVariants(text) {
    const chars = [...text.trim().replace(/\s+/g, ' ')];
    const a = toSimplifiedChars(chars).join('');
    const b = toSimplifiedChars(chars.map((c) => JP2T.get(c) || c)).join('');
    return a === b ? [b] : [b, a];
  }

  const hasTraditional = (text) => [...text].some((c) => T2S.has(c));

  function normalize(text) {
    const chars = [...(text || '').toLowerCase()].map((c) => JP2T.get(c) || c);
    return toSimplifiedChars(chars).join('').replace(/[\s\p{P}\p{S}]/gu, '');
  }
  const stripBrackets = (t) => (t || '').replace(/[（(《【\[].*?[）)》】\]]/g, '');

  // ---------- 保存 ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* 容量オーバーやプライベートモード。表示には影響させない */
      }
    },
  };

  let songs = store.get('ktv.songs', []);
  if (!Array.isArray(songs)) songs = [];
  const prefs = Object.assign({ fontScale: 1, toneColor: false, simplified: false }, store.get('ktv.prefs', {}));
  const saveSongs = () => store.set('ktv.songs', songs);
  const savePrefs = () => store.set('ktv.prefs', prefs);

  function upsertSong(song) {
    const old = songs.find((s) => s.id === song.id);
    if (old && !song.overrides) song.overrides = old.overrides;
    songs = [song, ...songs.filter((s) => s.id !== song.id)].slice(0, MAX_SAVED);
    saveSongs();
  }

  // ---------- 歌詞の解析 ----------
  const LRC_TAG = /\[(?:\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?|[a-z]+:[^\]]*)\]/gi;

  function cleanLyrics(text) {
    const lines = (text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(LRC_TAG, '').trimEnd());
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    // 空行が続くときは 1 行にまとめる
    return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
  }

  function analyzeLine(text) {
    const chars = [...text];
    const simp = toSimplifiedChars(chars);
    let res = pinyin(simp.join(''), { type: 'all' });
    if (res.length !== chars.length) {
      res = simp.map((c) => pinyin(c, { type: 'all' })[0] || { isZh: false, pinyin: c, polyphonic: [] });
    }
    return {
      text,
      cells: chars.map((ch, i) => ({
        ch,
        simp: simp[i],
        zh: !!res[i].isZh,
        auto: res[i].pinyin,
        alts: res[i].polyphonic || [],
      })),
    };
  }

  const TONE_MARKS = [
    'āēīōūǖ',
    'áéíóúǘḿń',
    'ǎěǐǒǔǚň',
    'àèìòùǜǹ',
  ];
  function toneOf(py) {
    for (let t = 0; t < TONE_MARKS.length; t++) {
      for (const m of TONE_MARKS[t]) if (py.includes(m)) return t + 1;
    }
    return 5;
  }

  // ---------- 表示 ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isPunct = (s) => /^[\p{P}\p{S}]+$/u.test(s);
  const isOpening = (s) => /^[\p{Ps}\p{Pi}]/u.test(s);

  let current = null; // { song, lines }

  function overrideKey(lineText, i) {
    return `${i}@${lineText}`;
  }

  function renderLine(line, l) {
    const { song } = current;
    // 1. 文字をまとまり（漢字1字 / 漢字以外の連続 / 空白）に分ける
    const tokens = [];
    line.cells.forEach((cell, i) => {
      if (/\s/.test(cell.ch)) {
        if (!tokens.length || tokens[tokens.length - 1].kind !== 'space') tokens.push({ kind: 'space' });
      } else if (cell.zh) {
        tokens.push({ kind: 'zh', cell, i });
      } else {
        const last = tokens[tokens.length - 1];
        if (last && last.kind === 'text') last.text += cell.ch;
        else tokens.push({ kind: 'text', text: cell.ch });
      }
    });

    // 2. 1つのまとまりを「ピンイン＋文字」の縦並びにする
    const unitHtml = (t) => {
      if (t.kind === 'zh') {
        const py = song.overrides[overrideKey(line.text, t.i)] || t.cell.auto;
        const edited = py !== t.cell.auto ? ' edited' : '';
        const hz = prefs.simplified ? t.cell.simp : t.cell.ch;
        return `<span class="u zh t${toneOf(py)}${edited}" data-i="${t.i}"><span class="py">${esc(py)}</span><span class="hz">${esc(hz)}</span></span>`;
      }
      return `<span class="u tx"><span class="py">&nbsp;</span><span class="hz">${esc(t.text)}</span></span>`;
    };

    // 3. 句読点は前の字と一緒にし、行頭に来ないようにする
    let html = '';
    let group = [];
    let openPending = false;
    const flush = () => {
      if (group.length === 1) html += group[0];
      else if (group.length > 1) html += `<span class="grp">${group.join('')}</span>`;
      group = [];
    };
    for (const t of tokens) {
      if (t.kind === 'space') {
        flush();
        openPending = false;
        html += ' ';
        continue;
      }
      const punct = t.kind === 'text' && isPunct(t.text);
      if (punct && isOpening(t.text)) {
        flush();
        group.push(unitHtml(t));
        openPending = true;
      } else if (punct || openPending) {
        group.push(unitHtml(t));
        openPending = false;
      } else {
        flush();
        group.push(unitHtml(t));
      }
    }
    flush();
    return `<div class="line" data-l="${l}">${html}</div>`;
  }

  function renderLyrics() {
    if (!current) return;
    const html = current.lines
      .map((line, l) => (line.text.trim() ? renderLine(line, l) : '<div class="line gap"></div>'))
      .join('');
    const el = $('lyrics');
    el.innerHTML = html || '<p class="empty">歌詞がありません。</p>';
    el.lang = prefs.simplified || !hasTraditional(current.song.lyrics) ? 'zh-Hans' : 'zh-Hant';
    el.classList.toggle('tone-color', prefs.toneColor);
    document.documentElement.style.setProperty('--lyric-scale', prefs.fontScale);
    $('tone-toggle').setAttribute('aria-pressed', String(prefs.toneColor));
    $('simp-toggle').setAttribute('aria-pressed', String(prefs.simplified));
    const title = current.song.title || '（無題）';
    $('song-title').textContent = prefs.simplified ? toSimplifiedChars([...title]).join('') : title;
    $('song-title').lang = $('lyrics').lang;
  }

  function openSong(id) {
    const song = songs.find((s) => s.id === id);
    if (!song) {
      location.replace('#/');
      return;
    }
    song.overrides = song.overrides || {};
    current = { song, lines: cleanLyrics(song.lyrics).map(analyzeLine) };
    $('song-artist').textContent = [song.artist, song.album].filter(Boolean).join(' · ');
    $('song-source').innerHTML =
      song.source === 'lrclib'
        ? '歌詞データ：<a href="https://lrclib.net/" target="_blank" rel="noopener">LRCLIB</a>'
        : '貼り付けた歌詞';
    document.title = `${song.title} | 中国語KTV`;
    renderLyrics();
    window.scrollTo(0, 0);
  }

  $('lyrics').addEventListener('click', (e) => {
    const u = e.target.closest('.u.zh');
    const lineEl = e.target.closest('.line');
    if (!u || !lineEl || !current) return;
    const line = current.lines[Number(lineEl.dataset.l)];
    const i = Number(u.dataset.i);
    const cell = line.cells[i];
    const cands = [...new Set([cell.auto, ...cell.alts])];
    if (cands.length < 2) {
      u.classList.remove('nope');
      void u.offsetWidth;
      u.classList.add('nope');
      return;
    }
    const key = overrideKey(line.text, i);
    const now = current.song.overrides[key] || cell.auto;
    const next = cands[(cands.indexOf(now) + 1) % cands.length];
    if (next === cell.auto) delete current.song.overrides[key];
    else current.song.overrides[key] = next;
    saveSongs();
    renderLyrics();
  });

  $('font-down').addEventListener('click', () => {
    prefs.fontScale = Math.max(0.6, Math.round((prefs.fontScale - 0.1) * 10) / 10);
    savePrefs();
    renderLyrics();
  });
  $('font-up').addEventListener('click', () => {
    prefs.fontScale = Math.min(2.4, Math.round((prefs.fontScale + 0.1) * 10) / 10);
    savePrefs();
    renderLyrics();
  });
  $('tone-toggle').addEventListener('click', () => {
    prefs.toneColor = !prefs.toneColor;
    savePrefs();
    renderLyrics();
  });
  $('simp-toggle').addEventListener('click', () => {
    prefs.simplified = !prefs.simplified;
    savePrefs();
    renderLyrics();
  });

  // ---------- 一覧 ----------
  const fmtDuration = (sec) => {
    if (!sec) return '';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const firstLine = (lyrics) => cleanLyrics(lyrics).find((l) => l.trim()) || '';

  function songItemHtml({ title, artist, meta, preview, attrs, removable }) {
    return `<li class="song-item">
      <button type="button" class="song-open" ${attrs}>
        <span class="song-name" lang="zh">${esc(title || '（無題）')}</span>
        <span class="song-sub">${esc([artist, meta].filter(Boolean).join(' · '))}</span>
        ${preview ? `<span class="song-preview" lang="zh">${esc(preview)}</span>` : ''}
      </button>
      ${removable ? `<button type="button" class="song-remove" ${attrs} aria-label="削除">×</button>` : ''}
    </li>`;
  }

  function renderSaved() {
    $('saved-list').innerHTML = songs
      .map((s) =>
        songItemHtml({
          title: s.title,
          artist: s.artist,
          attrs: `data-id="${esc(s.id)}"`,
          removable: true,
        }),
      )
      .join('');
    $('saved-empty').hidden = songs.length > 0;
  }

  $('saved-list').addEventListener('click', (e) => {
    const open = e.target.closest('.song-open');
    const remove = e.target.closest('.song-remove');
    if (remove) {
      const song = songs.find((s) => s.id === remove.dataset.id);
      if (song && confirm(`「${song.title}」を削除しますか？`)) {
        songs = songs.filter((s) => s.id !== song.id);
        saveSongs();
        renderSaved();
      }
    } else if (open) {
      const song = songs.find((s) => s.id === open.dataset.id);
      if (song) upsertSong(song); // 最近開いた順に並べる
      location.hash = `#/song/${encodeURIComponent(open.dataset.id)}`;
    }
  });

  // ---------- 検索 ----------
  let results = [];
  let searchSeq = 0;

  async function fetchSearch(q) {
    const res = await fetch(`${LRCLIB_SEARCH}?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function search(title, artist) {
    const titleVariants = queryVariants(title);
    const artistVariants = artist ? queryVariants(artist) : [''];
    const queries = [...new Set(titleVariants.flatMap((t) => artistVariants.map((a) => `${t} ${a}`.trim())))];
    const settled = await Promise.allSettled(queries.map(fetchSearch));
    if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;

    const qTitle = normalize(title);
    const qArtist = normalize(artist);
    const seen = new Set();
    const merged = [];
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const item of r.value) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.instrumental || !(item.plainLyrics || item.syncedLyrics)) continue;
        merged.push(item);
      }
    }
    const score = (item) => {
      const t = normalize(stripBrackets(item.trackName)) || normalize(item.trackName);
      let s = t === qTitle ? 100 : t.startsWith(qTitle) ? 60 : t.includes(qTitle) ? 40 : 0;
      if (qArtist && normalize(item.artistName).includes(qArtist)) s += 30;
      if (item.syncedLyrics) s += 2;
      return s;
    };
    merged.forEach((item, idx) => {
      item._score = score(item);
      item._idx = idx;
    });
    merged.sort((x, y) => y._score - x._score || x._idx - y._idx);

    // 同じ歌手の同じ歌詞（繁体字版・簡体字版など）は1つにまとめる
    const dedup = new Set();
    return merged.filter((item) => {
      const lyr = item.plainLyrics || item.syncedLyrics;
      const key = `${normalize(item.artistName)}|${normalize(cleanLyrics(lyr).join('')).slice(0, 40)}`;
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    }).slice(0, 30);
  }

  function renderResults(state, message) {
    $('results').hidden = false;
    $('results-note').textContent = message || '';
    if (state === 'loading') {
      $('result-list').innerHTML = '<li class="loading">検索しています…</li>';
      return;
    }
    if (state === 'error') {
      $('result-list').innerHTML = '';
      return;
    }
    $('result-list').innerHTML = results
      .map((r, idx) =>
        songItemHtml({
          title: r.trackName,
          artist: r.artistName,
          meta: [r.albumName && r.albumName !== r.trackName ? r.albumName : '', fmtDuration(r.duration)].filter(Boolean).join(' · '),
          preview: firstLine(r.plainLyrics || r.syncedLyrics),
          attrs: `data-idx="${idx}"`,
        }),
      )
      .join('');
  }

  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('q-title').value.trim();
    const artist = $('q-artist').value.trim();
    if (!title) return;
    document.activeElement.blur();
    const seq = ++searchSeq;
    const shown = [queryVariants(title)[0], artist && queryVariants(artist)[0]].filter(Boolean).join(' ');
    const searchedAs = shown !== [title, artist].filter(Boolean).join(' ') ? `「${shown}」で検索しました。` : '';
    renderResults('loading');
    $('search-btn').disabled = true;
    try {
      const found = await search(title, artist);
      if (seq !== searchSeq) return;
      results = found;
      if (!results.length) {
        renderResults('done', `${searchedAs}見つかりませんでした。曲名の表記を変えるか、歌手名を入れて試してください。`);
      } else {
        renderResults('done', `${searchedAs}${results.length}件見つかりました。歌詞の1行目を見て選んでください。`);
      }
    } catch (err) {
      if (seq !== searchSeq) return;
      renderResults('error', navigator.onLine === false
        ? 'ネットにつながっていません。保存した曲は開けます。'
        : `検索できませんでした（${err.message}）。少し待ってからもう一度試してください。`);
    } finally {
      if (seq === searchSeq) $('search-btn').disabled = false;
    }
  });

  $('result-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.song-open');
    if (!btn) return;
    const r = results[Number(btn.dataset.idx)];
    if (!r) return;
    const id = `lrclib:${r.id}`;
    upsertSong({
      id,
      title: r.trackName,
      artist: r.artistName,
      album: r.albumName || '',
      lyrics: r.plainLyrics || r.syncedLyrics,
      source: 'lrclib',
      savedAt: Date.now(),
    });
    location.hash = `#/song/${encodeURIComponent(id)}`;
  });

  // ---------- 貼り付け ----------
  $('paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lyrics = $('p-lyrics').value;
    if (!lyrics.trim()) return;
    const title = $('p-title').value.trim() || firstLine(lyrics).slice(0, 20);
    const id = `paste:${Date.now().toString(36)}`;
    upsertSong({ id, title, artist: '', album: '', lyrics, source: 'paste', savedAt: Date.now() });
    $('p-title').value = '';
    $('p-lyrics').value = '';
    location.hash = `#/song/${encodeURIComponent(id)}`;
  });

  // ---------- 画面を消さない（歌っている間） ----------
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => keepAwake(!$('song').hidden));

  // ---------- 画面の切り替え ----------
  function route() {
    const m = location.hash.match(/^#\/song\/(.+)$/);
    if (m) {
      $('home').hidden = true;
      $('song').hidden = false;
      openSong(decodeURIComponent(m[1]));
      keepAwake(true);
    } else {
      $('song').hidden = true;
      $('home').hidden = false;
      document.title = '中国語KTV';
      current = null;
      renderSaved();
      keepAwake(false);
    }
  }
  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
