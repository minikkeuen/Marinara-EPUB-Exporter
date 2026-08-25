(() => {
  "use strict";

  const VERSION = "0.7.0";
  const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  const BUTTON_ID = "mari-epub-exporter-button";
  const PANEL_ID = "mari-epub-exporter-panel";
  const MAX_PAGES = 200;
  const PAGE_LIMIT = 100;
  const SETTINGS_KEY = "marinara.epub-exporter.settings.v1";
  const DEFAULT_SETTINGS = {
    showAuthorName: false,
    showTime: false,
    removeStatus: true,
    statusDateMarker: true,
    splitByDate: false,
    includeOpening: false,
    turnSeparator: "line",
    filenameRule: "title",
    contentMode: "translation-first"
  };

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      return parsed && typeof parsed === "object" ? { ...DEFAULT_SETTINGS, ...parsed } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(value) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); } catch {}
  }

  function exportDateStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function exportFilename(rule, title, characterName) {
    if (rule === "character-title") return `${characterName || "Character"} - ${title}`;
    if (rule === "title-date") return `${title} - ${exportDateStamp()}`;
    return title;
  }

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const cleanText = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();
  const safeFilename = (value) => String(value || "Marinara Chat").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "Marinara Chat";
  const uid = () => `urn:uuid:${crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const extractArray = (payload) => Array.isArray(payload) ? payload : (payload?.items || payload?.messages || payload?.results || []);
  const isVisible = (el) => {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  async function api(path, options = {}) {
    const clean = String(path || "").replace(/^\/?api\//, "").replace(/^\//, "");
    const headers = new Headers(options.headers || {});
    try { const admin = localStorage.getItem("marinara_admin_secret")?.trim(); if (admin) headers.set("X-Admin-Secret", admin); } catch {}
    const res = await fetch(`/api/${clean}`, { ...options, headers, credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") || "";
    return type.includes("application/json") ? res.json() : res.text();
  }

  function activeChatId() {
    try {
      const id = localStorage.getItem(ACTIVE_CHAT_KEY);
      if (id?.trim()) return id.trim();
    } catch {}
    for (const entry of performance.getEntriesByType("resource").slice().reverse()) {
      const m = entry.name.match(/\/api\/chats\/([^/?]+)\/messages(?:[/?]|$)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }

  async function resolveChatId() {
    const direct = activeChatId();
    if (direct) return direct;
    const visibleIds = new Set([...document.querySelectorAll("[data-message-id]")].filter(isVisible).map((el) => el.getAttribute("data-message-id")).filter(Boolean));
    if (!visibleIds.size) return null;
    const payload = await api("chats");
    const chats = extractArray(payload).sort((a,b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)).slice(0, 30);
    let best = null;
    for (const chat of chats) {
      const id = String(chat?.id || ""); if (!id) continue;
      try {
        const data = await api(`chats/${encodeURIComponent(id)}/messages?limit=100`);
        const rows = extractArray(data);
        const ids = new Set(rows.map((m) => String(m?.id || "")));
        const score = [...visibleIds].reduce((n, mid) => n + (ids.has(mid) ? 1 : 0), 0);
        if (score && (!best || score > best.score)) best = { id, score };
      } catch {}
    }
    return best?.id || null;
  }

  async function loadAllMessages(chatId, onProgress) {
    // Marinara returns the complete chronological chat history when `limit` is omitted.
    // For ordinary chat sizes this is both simpler and more reliable than cursor pagination,
    // and it guarantees that the initial greeting is included.
    const payload = await api(`chats/${encodeURIComponent(chatId)}/messages`);
    const rows = extractArray(payload);
    onProgress?.(rows.length);
    return rows;
  }

  function parseExtra(message) {
    const raw = message?.extra;
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string") { try { return JSON.parse(raw); } catch {} }
    return {};
  }

  function firstText(values) {
    for (const value of values) if (typeof value === "string" && value.trim()) return value;
    return "";
  }

  function translatedContent(message) {
    const extra = parseExtra(message);
    return firstText([
      message?.translation, message?.translatedText, message?.translatedContent, message?.translationText,
      extra?.translation, extra?.translatedText, extra?.translatedContent, extra?.translationText,
      extra?.translation?.text, extra?.translation?.content, extra?.translated?.text, extra?.translated?.content,
      extra?.translations?.ko, extra?.translations?.['ko-KR'], extra?.translations?.korean
    ]);
  }

  function originalContent(message) {
    return firstText([message?.content, message?.text, message?.message]);
  }

  function statusSourceTexts(message) {
    const extra = parseExtra(message);
    const values = [
      message?.content, message?.translationSource, message?.translation_source,
      message?.text, message?.message,
      extra?.translationSource, extra?.translation_source, extra?.sourceText, extra?.source_text,
      translatedContent(message)
    ];
    const seen = new Set();
    return values.filter((value) => {
      if (typeof value !== "string" || !value.trim()) return false;
      const key = value.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function messageContent(message) {
    return translatedContent(message) || originalContent(message);
  }

  function messageContentByMode(message, mode) {
    const translated = translatedContent(message);
    const original = originalContent(message);
    if (mode === "original-first") return original || translated;
    return translated || original;
  }

  function looksLikeStatusBlock(inner, opener = "") {
    const text = String(inner || "").trim();
    if (!text) return true;
    const head = `${opener} ${text.slice(0, 240)}`.toLowerCase();
    const statusWords = /(status|stats|state|상태|상태창|status window|status panel|character status|현재 상태|정보창|스탯|hp\b|mp\b|health\b|location\b|위치\s*[:：]|시간\s*[:：]|날짜\s*[:：]|호감도|관계\s*[:：])/i;
    const keyValueLines = text.split(/\n/).filter((line) => /[:：]/.test(line)).length;
    const tableish = text.split(/\n/).filter((line) => /^\s*[|┃│]/.test(line) || /[|┃│]\s*$/.test(line)).length;
    const pipeSegments = (text.match(/[|┃│]/g) || []).length;
    // Pipe-delimited bracket blocks are a common Marinara/RP status-window form.
    // Date presence is irrelevant to removal: e.g. [ Location | Mood | ◾️ | ⚪️ ]
    // must still be recognized as a status panel.
    const pipeStatus = pipeSegments >= 2;
    return statusWords.test(head) || keyValueLines >= 2 || tableish >= 2 || pipeStatus || (text.includes("\n") && keyValueLines >= 1);
  }

  function extractStatusDate(value) {
    const text = cleanText(value);
    if (!text) return null;
    const dateMatch = text.match(/((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
    if (!dateMatch) return null;

    // DAY N / N일 차 may appear anywhere in the same status source.
    // Prefer a day marker near the date, then fall back to the whole source.
    const around = text.slice(Math.max(0, dateMatch.index - 180), Math.min(text.length, (dateMatch.index || 0) + dateMatch[0].length + 180));
    const dayMatch = around.match(/(?:DAY\s*(\d+)|(\d+)\s*일\s*차)/i) || text.match(/(?:DAY\s*(\d+)|(\d+)\s*일\s*차)/i);
    const year = dateMatch[1];
    const month = String(Number(dateMatch[2])).padStart(2, "0");
    const day = String(Number(dateMatch[3])).padStart(2, "0");
    const dayNumber = dayMatch ? Number(dayMatch[1] || dayMatch[2]) : null;
    return { key: `${year}-${month}-${day}`, label: `${year}. ${month}. ${day}`, dayNumber: Number.isFinite(dayNumber) ? dayNumber : null };
  }

  function removeStatusWindows(value) {
    let text = cleanText(value);
    if (!text) return "";

    // Markdown fenced status panels.
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (all, info, body) =>
      looksLikeStatusBlock(body, info) ? "" : all
    );

    // [ ... ] and 【 ... 】 status windows can appear on their own line
    // or be attached before/after prose. Remove only blocks that actually
    // look like status panels, preserving ordinary bracketed prose.
    text = text.replace(/\[([\s\S]{0,5000}?)\]/g, (all, body) =>
      looksLikeStatusBlock(body, "[") ? "" : all
    );
    text = text.replace(/【([\s\S]{0,5000}?)】/g, (all, body) =>
      looksLikeStatusBlock(body, "【") ? "" : all
    );

    // Common explicit labels / one-line panels.
    text = text.split("\n").filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^(?:\[|【|〔|〈|<)?\s*(?:status|stats|state|상태|상태창|현재 상태|정보창|캐릭터 상태)\b/i.test(t)) return false;
      if (/^[\[【〔〈<].*[\]】〕〉>]$/.test(t) && looksLikeStatusBlock(t.slice(1, -1))) return false;
      return true;
    }).join("\n");

    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  function messageAuthor(message, characterName, personaName) {
    const role = String(message?.role || "");
    if (role === "user") return personaName || "User";
    if (role === "assistant") return characterName || "Assistant";
    return role || "Message";
  }

  function textToXhtml(text) {
    return cleanText(text).split(/\n{2,}/).map((block) => `<p>${esc(block).replace(/\n/g, "<br />")}</p>`).join("\n");
  }

  function dayMarkerHtml(statusDate) {
    if (!statusDate) return "";
    const dayLine = statusDate.dayNumber != null ? `<div class="day-marker-day">DAY ${statusDate.dayNumber}</div>` : "";
    return `<section class="day-marker">${dayLine}<div class="day-marker-date">${esc(statusDate.label)}</div></section>`;
  }

  function chapterLabel(statusDate) {
    if (!statusDate) return "";
    return statusDate.dayNumber != null ? `DAY ${statusDate.dayNumber} · ${statusDate.label}` : statusDate.label;
  }

  function buildChapters(messages, opts, chat, characterName, personaName, openingMessage = null) {
    const sourceMessages = openingMessage ? [openingMessage, ...messages] : messages;
    const entries = [];

    for (const m of sourceMessages) {
      const role = String(m?.role || "");
      if (!["user", "assistant"].includes(role)) continue;
      const extra = parseExtra(m);
      if (extra?.hiddenFromUser === true) continue;

      let content = messageContentByMode(m, opts.contentMode);
      const statusDate = (opts.statusDateMarker || opts.splitByDate)
        ? statusSourceTexts(m).map(extractStatusDate).find(Boolean) || null
        : null;

      if (opts.removeStatus) content = removeStatusWindows(content);

      let html = "";
      if (content) {
        const author = messageAuthor(m, characterName, personaName);
        const created = m?.createdAt || m?.created_at || "";
        const separator = opts.turnSeparator === "line"
          ? '<hr class="turn-separator" />'
          : opts.turnSeparator === "space"
            ? '<div class="turn-space" aria-hidden="true"></div>'
            : "";
        html = `<section class="message">` +
          (opts.showAuthorName ? `<div class="author">${esc(author)}</div>` : "") +
          (opts.showTime && created ? `<div class="time">${esc(new Date(created).toLocaleString("ko-KR"))}</div>` : "") +
          `<div class="content">${textToXhtml(content)}</div></section>${separator}`;
      }

      if (html || statusDate) entries.push({ html, statusDate });
    }

    if (!opts.splitByDate) {
      const parts = [];
      let lastStatusDate = null;
      for (const entry of entries) {
        if (opts.statusDateMarker && entry.statusDate && entry.statusDate.key !== lastStatusDate) {
          parts.push(dayMarkerHtml(entry.statusDate));
          lastStatusDate = entry.statusDate.key;
        }
        if (entry.html) parts.push(entry.html);
      }
      return [{ title: "", content: parts.join("\n") }];
    }

    const firstDateIndex = entries.findIndex((entry) => !!entry.statusDate);
    if (firstDateIndex < 0) {
      return [{ title: "", content: entries.map((entry) => entry.html).filter(Boolean).join("\n") }];
    }

    const chapters = [];

    // Messages before the first explicit in-world date must not be assigned
    // to that later date. Keep them in their own undated chapter.
    const undatedPrefix = entries
      .slice(0, firstDateIndex)
      .map((entry) => entry.html)
      .filter(Boolean)
      .join("\n");
    if (undatedPrefix.trim()) {
      chapters.push({ title: null, content: undatedPrefix });
    }

    let currentDate = entries[firstDateIndex].statusDate;
    let current = { title: chapterLabel(currentDate), content: [] };

    for (let index = firstDateIndex; index < entries.length; index++) {
      const entry = entries[index];

      if (entry.statusDate && entry.statusDate.key !== currentDate.key) {
        if (current.content.join("").trim()) {
          chapters.push({ title: current.title, content: current.content.join("\n") });
        }
        currentDate = entry.statusDate;
        current = { title: chapterLabel(currentDate), content: [] };
      }

      // When chapters are already split by date, the chapter title itself is the date marker.
      // Do not duplicate the same date inside the chapter body.
      if (entry.html) current.content.push(entry.html);
    }

    if (current.content.join("").trim()) {
      chapters.push({ title: current.title, content: current.content.join("\n") });
    }
    return chapters.filter((chapter) => chapter.content.trim());
  }

  function crc32(bytes) {
    let c = 0 ^ -1;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }
  const le16 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255);
  const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  function concatBytes(parts) {
    const total = parts.reduce((n,p) => n + p.length, 0), out = new Uint8Array(total); let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }
  function makeZip(entries) {
    const te = new TextEncoder();
    const locals = [], centrals = []; let offset = 0;
    const dt = dosDateTime();
    for (const entry of entries) {
      const name = te.encode(entry.name);
      const data = typeof entry.data === "string" ? te.encode(entry.data) : entry.data;
      const crc = crc32(data);
      const local = concatBytes([
        le32(0x04034b50), le16(20), le16(0), le16(0), le16(dt.time), le16(dt.day), le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0), name, data
      ]);
      const central = concatBytes([
        le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(dt.time), le16(dt.day), le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name
      ]);
      locals.push(local); centrals.push(central); offset += local.length;
    }
    const centralBytes = concatBytes(centrals);
    const end = concatBytes([le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length), le32(centralBytes.length), le32(offset), le16(0)]);
    return concatBytes([...locals, centralBytes, end]);
  }

  function epubFiles({ title, identifier, language, chapters, modified }) {
    const css = `body{font-family:serif;line-height:1.72;margin:5%;}h1{font-size:1.45em;margin:0 0 1.5em}.message{margin:0;page-break-inside:avoid}.author{font-family:sans-serif;font-size:.78em;font-weight:700;opacity:.72;margin:0 0 .25em}.time{font-family:sans-serif;font-size:.66em;opacity:.5;margin:-.1em 0 .35em}.content p{margin:.35em 0}.turn-separator{border:0;border-top:1px solid currentColor;opacity:.22;margin:1.35em 0}.turn-space{height:1.7em}.day-marker{text-align:center;margin:2.8em 0 1.7em;page-break-after:avoid}.day-marker-day{font-family:sans-serif;font-size:.78em;font-weight:700;letter-spacing:.08em;margin-bottom:.25em}.day-marker-date{font-family:sans-serif;font-size:.9em;opacity:.72;letter-spacing:.04em}`;
    const container = `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const normalized = Array.isArray(chapters) && chapters.length ? chapters : [{ title: "", content: "" }];

    const chapterItems = normalized.map((chapter, index) => {
      const n = index + 1;
      const href = `chapter-${n}.xhtml`;
      const id = `chapter-${n}`;
      const blankTitle = chapter.title === null;
      const label = blankTitle ? "\u00a0" : (chapter.title || title);
      const heading = blankTitle ? "" : `<h1>${esc(label)}</h1>`;
      const xhtml = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(language)}"><head><meta charset="utf-8"/><title>${esc(blankTitle ? title : label)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${heading}${chapter.content || ""}</body></html>`;
      return { href, id, label, xhtml };
    });

    const navItems = chapterItems.map((item) => `<li><a href="${item.href}">${esc(item.label)}</a></li>`).join("");
    const nav = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(title)}</title></head><body><nav epub:type="toc" id="toc"><h1>목차</h1><ol>${navItems}</ol></nav></body></html>`;
    const manifestChapters = chapterItems.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`).join("");
    const spineChapters = chapterItems.map((item) => `<itemref idref="${item.id}"/>`).join("");
    const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${esc(identifier)}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${esc(language)}</dc:language><dc:creator>Marinara EPUB Exporter</dc:creator><meta property="dcterms:modified">${esc(modified)}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifestChapters}<item id="css" href="style.css" media-type="text/css"/></manifest><spine>${spineChapters}</spine></package>`;

    return [
      { name: "mimetype", data: "application/epub+zip" },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/nav.xhtml", data: nav },
      ...chapterItems.map((item) => ({ name: `OEBPS/${item.href}`, data: item.xhtml })),
      { name: "OEBPS/style.css", data: css }
    ];
  }

  function download(name, bytes) {
    const blob = new Blob([bytes], { type: "application/epub+zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // Remove orphaned exporter UI left by an older enabled instance.
  document.querySelectorAll('[data-mep-toolbar-entry]').forEach((entry) => entry.remove());
  document.getElementById(BUTTON_ID)?.remove();
  document.getElementById(PANEL_ID)?.remove();

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.style.order = "-9999";
  button.className = "marinara-chat-toolbar-button flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text)] backdrop-blur-md transition-all hover:border-[var(--marinara-chat-chrome-button-border-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] hover:text-[var(--marinara-chat-chrome-button-text-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] h-8 w-8 p-1.5";
  button.title = "Export EPUB";
  button.setAttribute("aria-label", "Export EPUB");
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13V7"/><path d="m9 10 3 3 3-3"/><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M8 17h8"/></svg>`;
  const panel = document.createElement("section"); panel.id = PANEL_ID; panel.hidden = true;
  panel.innerHTML = `<div class="mep-head"><strong>EPUB Exporter <span style="opacity:.55">v${VERSION}</span></strong><button type="button" data-act="close" aria-label="닫기">×</button></div><div class="mep-body"><div class="mep-row"><label>책 제목</label><input type="text" name="title" placeholder="현재 채팅 제목을 자동 사용" /></div><div class="mep-select-group"><div class="mep-row"><label>파일명 규칙</label><select name="filenameRule"><option value="title">책 제목</option><option value="character-title">캐릭터명 - 책 제목</option><option value="title-date">책 제목 - 날짜</option></select></div><div class="mep-row"><label>본문 저장 방식</label><select name="contentMode"><option value="translation-first">번역문 우선</option><option value="original-first">원문 우선</option></select></div><div class="mep-row"><label>턴 구분 방식</label><select name="turnSeparator"><option value="line">가로선</option><option value="space">여백</option><option value="none">없음</option></select></div></div><div class="mep-check-group"><label class="mep-check"><input type="checkbox" name="showAuthorName" /> 캐릭터/페르소나명 표시</label><label class="mep-check"><input type="checkbox" name="showTime" /> 채팅 시간 표시</label><label class="mep-check"><input type="checkbox" name="removeStatus" checked /> 상태창 제거 ([ ], 【 】, Status/상태 형식 등)</label><label class="mep-check"><input type="checkbox" name="statusDateMarker" checked /> 상태창 날짜 표시</label><label class="mep-check"><input type="checkbox" name="splitByDate" /> 날짜별 챕터 분할</label><label class="mep-check"><input type="checkbox" name="includeOpening" /> 누락된 도입부 추가</label></div><button type="button" class="mep-button mep-primary" data-act="export">현재 채팅 EPUB 내보내기</button><div class="mep-status" data-status>현재 채팅을 확인할 준비가 됐습니다.</div><div class="mep-note">선택한 본문 저장 방식에 따라 번역문 또는 원문을 사용합니다. 유저 입력과 캐릭터 지문은 같은 본문 스타일로 출력됩니다.</div></div>`
  document.body.append(panel);

  function readPanelSettings() {
    return {
      showAuthorName: panel.querySelector('[name="showAuthorName"]').checked,
      showTime: panel.querySelector('[name="showTime"]').checked,
      removeStatus: panel.querySelector('[name="removeStatus"]').checked,
      statusDateMarker: panel.querySelector('[name="statusDateMarker"]').checked,
      splitByDate: panel.querySelector('[name="splitByDate"]').checked,
      includeOpening: panel.querySelector('[name="includeOpening"]').checked,
      turnSeparator: panel.querySelector('[name="turnSeparator"]').value || "line",
      filenameRule: panel.querySelector('[name="filenameRule"]').value || "title",
      contentMode: panel.querySelector('[name="contentMode"]').value || "translation-first"
    };
  }

  function applyPanelSettings(settings) {
    const value = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    panel.querySelector('[name="showAuthorName"]').checked = !!value.showAuthorName;
    panel.querySelector('[name="showTime"]').checked = !!value.showTime;
    panel.querySelector('[name="removeStatus"]').checked = value.removeStatus !== false;
    panel.querySelector('[name="statusDateMarker"]').checked = value.statusDateMarker !== false;
    panel.querySelector('[name="splitByDate"]').checked = !!value.splitByDate;
    panel.querySelector('[name="includeOpening"]').checked = !!value.includeOpening;
    panel.querySelector('[name="turnSeparator"]').value = ["line", "space", "none"].includes(value.turnSeparator) ? value.turnSeparator : "line";
    panel.querySelector('[name="filenameRule"]').value = ["title", "character-title", "title-date"].includes(value.filenameRule) ? value.filenameRule : "title";
    panel.querySelector('[name="contentMode"]').value = ["translation-first", "original-first"].includes(value.contentMode) ? value.contentMode : "translation-first";
  }

  applyPanelSettings(loadSettings());
  panel.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.name === "title") return;
    saveSettings(readPanelSettings());
  });

  const placePanel = () => {
    if (!button.isConnected || panel.hidden) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(360, Math.max(280, innerWidth - 24));
    const left = Math.min(Math.max(12, rect.right - width), innerWidth - width - 12);
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    panel.style.top = `${Math.min(innerHeight - 12, rect.bottom + 8)}px`;
    panel.style.bottom = "auto";
  };

  const ROLEPLAY_TOOLBAR_SELECTOR = '[data-chat-mode="roleplay"] [data-roleplay-top-controls="right"]';
  const TOOLBAR_BUTTON_ATTR = "data-mep-toolbar-entry";
  button.setAttribute(TOOLBAR_BUTTON_ATTR, "true");
  button.className = "marinara-chat-toolbar-button flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text)] backdrop-blur-md transition-all hover:border-[var(--marinara-chat-chrome-button-border-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] hover:text-[var(--marinara-chat-chrome-button-text-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] h-8 w-8 p-1.5";

  function createRoleplayToolbarButton(target) {
    if (!(target instanceof HTMLElement)) return null;
    const existing = target.querySelector(`:scope > [${TOOLBAR_BUTTON_ATTR}]`);
    if (existing instanceof HTMLButtonElement) {
      if (existing !== button) button.remove();
      return existing;
    }
    target.appendChild(button);
    button.hidden = false;
    return button;
  }

  function ensureRoleplayToolbarButtons() {
    const targets = document.querySelectorAll(ROLEPLAY_TOOLBAR_SELECTOR);
    targets.forEach((target) => createRoleplayToolbarButton(target));
    return targets.length;
  }

  // Match JSX Bridge's reliable toolbar mounting pattern without observing the whole chat DOM.
  // The toolbar may not exist until a Roleplay room is opened long after the extension loads,
  // so keep only a very cheap toolbar query on a 900ms interval.
  ensureRoleplayToolbarButtons();
  setTimeout(ensureRoleplayToolbarButtons, 120);
  setTimeout(ensureRoleplayToolbarButtons, 900);
  const toolbarPoll = setInterval(() => {
    ensureRoleplayToolbarButtons();
    if (!panel.hidden) placePanel();
  }, 900);

  const status = panel.querySelector("[data-status]");
  const setStatus = (text, tone = "") => { status.textContent = text; status.dataset.tone = tone; };
  button.addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      requestAnimationFrame(placePanel);
      try {
        const chatId = await resolveChatId();
        if (chatId) {
          const titleInput = panel.querySelector('[name="title"]');
          if ((titleInput.dataset.chatId || "") !== chatId) {
            const chat = await api(`chats/${encodeURIComponent(chatId)}`);
            const defaultTitle = String(chat?.name || chat?.title || "Marinara Chat").trim() || "Marinara Chat";
            titleInput.value = defaultTitle;
            titleInput.dataset.chatId = chatId;
          }
        }
      } catch {}
    }
  });
  panel.querySelector('[data-act="close"]').addEventListener("click", () => { panel.hidden = true; });
  window.addEventListener("resize", () => { if (!panel.hidden) placePanel(); });
  function cleanupExtensionUi() {
    clearInterval(toolbarPoll);
    document.querySelectorAll(`[${TOOLBAR_BUTTON_ATTR}]`).forEach((entry) => entry.remove());
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }

  try {
    if (typeof marinara?.onCleanup === "function") {
      marinara.onCleanup(cleanupExtensionUi);
    }
  } catch {}
  panel.querySelector('[data-act="export"]').addEventListener("click", async () => {
    const exportButton = panel.querySelector('[data-act="export"]');
    exportButton.disabled = true;
    try {
      setStatus("현재 채팅을 찾는 중…");
      const chatId = await resolveChatId();
      if (!chatId) throw new Error("현재 채팅 ID를 찾지 못했습니다. 채팅 화면에서 다시 시도해 주세요.");
      const chat = await api(`chats/${encodeURIComponent(chatId)}`);
      const defaultTitle = String(chat?.name || chat?.title || "Marinara Chat").trim() || "Marinara Chat";
      const titleInput = panel.querySelector('[name="title"]');
      const boundChatId = titleInput.dataset.chatId || "";
      if (boundChatId !== chatId) {
        titleInput.value = defaultTitle;
        titleInput.dataset.chatId = chatId;
      } else if (!titleInput.value.trim()) {
        titleInput.value = defaultTitle;
      }
      const title = titleInput.value.trim() || defaultTitle;
      let characterName = "Assistant";
      let characterData = null;
      const characterIds = Array.isArray(chat?.characterIds) ? chat.characterIds : (() => { try { return JSON.parse(chat?.characterIds || "[]"); } catch { return []; } })();
      if (characterIds?.[0]) {
        try {
          const c = await api(`characters/${encodeURIComponent(characterIds[0])}`);
          const parsedData = typeof c?.data === "string" ? (() => { try { return JSON.parse(c.data); } catch { return null; } })() : c?.data;
          characterData = parsedData && typeof parsedData === "object" ? parsedData : c;
          characterName = String(c?.name || characterData?.name || characterName);
        } catch {}
      }
      let personaName = "User";
      const personaIds = Array.isArray(chat?.personaIds) ? chat.personaIds : (() => {
        if (chat?.personaId) return [chat.personaId];
        try { const parsed = JSON.parse(chat?.personaIds || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
      })();
      if (personaIds?.[0]) {
        try { const p = await api(`personas/${encodeURIComponent(personaIds[0])}`); personaName = String(p?.name || p?.data?.name || personaName); } catch {}
      }
      personaName = String(chat?.personaName || chat?.userName || personaName);
      const messages = await loadAllMessages(chatId, (n) => setStatus(`메시지 불러오는 중… ${n.toLocaleString()}개`));
      if (!messages.length) throw new Error("내보낼 메시지가 없습니다.");
      const opts = readPanelSettings();
      saveSettings(opts);
      let openingMessage = null;
      if (opts.includeOpening && characterData) {
        const firstMes = firstText([characterData?.first_mes, characterData?.firstMes, characterData?.firstMessage, characterData?.greeting]);
        if (firstMes) {
          const normalizedOpening = cleanText(firstMes);
          const alreadyPresent = messages.some((m) => String(m?.role || "") === "assistant" && cleanText(originalContent(m)) === normalizedOpening);
          if (!alreadyPresent) {
            openingMessage = { role: "assistant", content: firstMes, characterId: characterIds?.[0] || null, createdAt: null, __epubOpening: true };
          }
        }
      }
      setStatus(`EPUB 생성 중… ${messages.length.toLocaleString()}개 메시지${openingMessage ? " + 도입부" : ""}`);
      const chapters = buildChapters(messages, opts, chat, characterName, personaName, openingMessage);
      const files = epubFiles({ title, identifier: uid(), language: "ko", chapters, modified: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
      const bytes = makeZip(files);
      const filename = exportFilename(opts.filenameRule, title, characterName);
      download(`${safeFilename(filename)}.epub`, bytes);
      const chapterInfo = chapters.length > 1 ? ` · ${chapters.length.toLocaleString()}개 챕터` : "";
      setStatus(`완료 · ${messages.length.toLocaleString()}개 메시지${openingMessage ? " + 도입부" : ""}${chapterInfo} · ${(bytes.length / 1024 / 1024).toFixed(2)} MB`, "ok");
    } catch (error) {
      console.error("[Marinara EPUB Exporter]", error);
      setStatus(error?.message || String(error), "error");
    } finally { exportButton.disabled = false; }
  });
})();
