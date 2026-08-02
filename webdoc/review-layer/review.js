/*
 * The review layer.
 *
 * Injected only into the reviewer's bundle by scripts/make-review-bundle.mjs.
 * The published site never loads it, so nothing here can reach a real reader.
 *
 * Select text — or hover an image — and a button appears; write a note and it is
 * kept in this browser's localStorage, marked in place, and counted in the bar
 * at the bottom right. "Export" writes one Markdown file holding every note,
 * grouped by the SOURCE FILE that has to be edited, which the layer works out
 * from the page's own URL. That is the point of the whole thing: the file that
 * comes back says where each complaint lives, not just what it was.
 */

(() => {
  const KEY = 'tdc-review-v1';
  const LOCALES = ['ru', 'es'];

  const T = {
    comment: 'Comment',
    heading: 'Comment on the selection',
    image: 'Comment on this image',
    save: 'Save',
    cancel: 'Cancel',
    remove: 'Delete',
    placeholder: "What's wrong here?",
    export: 'Export',
    clear: 'Clear',
    list: 'List',
    none: 'Nothing marked yet.',
    confirm: 'Delete every comment? This cannot be undone.',
    countOne: 'comment',
    countMany: 'comments',
  };

  const plural = (n) => (n === 1 ? T.countOne : T.countMany);

  // ------------------------------------------------------------------ storage

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    localStorage.setItem(KEY, JSON.stringify(list));
  };

  /**
   * Which file in the repository produced this page. Docusaurus serves
   * /docs/<path> for English and /<locale>/docs/<path> for the rest, and the
   * sources sit in a fixed place for each.
   */
  const sourceOf = (pathname) => {
    const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let locale = 'en';
    if (LOCALES.includes(parts[0])) locale = parts.shift();
    if (parts[0] !== 'docs') return null;
    parts.shift();
    const rel = parts.length > 0 ? parts.join('/') : 'intro';
    return locale === 'en'
      ? `webdoc/docs/${rel}.mdx`
      : `webdoc/i18n/${locale}/docusaurus-plugin-content-docs/current/${rel}.mdx`;
  };

  const root = () => document.querySelector('article') ?? document.querySelector('main');

  // ------------------------------------------------------- finding a passage

  /** Every text node under `el`, in document order, ignoring our own markup. */
  const textNodes = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest('#tdcr-bar, #tdcr-list, #tdcr-modal, .tdcr-badge')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const out = [];
    let n = walker.nextNode();
    while (n) {
      out.push(n);
      n = walker.nextNode();
    }
    return out;
  };

  /**
   * Wrap the `nth` occurrence of `quote` in a <mark>. Works across element
   * boundaries by treating the page as one string and mapping back to nodes,
   * which is what a selection spanning a link or a bold word needs.
   */
  const wrapQuote = (el, quote, nth, id) => {
    const nodes = textNodes(el);
    let all = '';
    const spans = [];
    for (const node of nodes) {
      spans.push({ node, start: all.length, end: all.length + node.data.length });
      all += node.data;
    }

    let from = -1;
    let seen = 0;
    let at = all.indexOf(quote);
    while (at !== -1) {
      if (seen === nth) {
        from = at;
        break;
      }
      seen++;
      at = all.indexOf(quote, at + 1);
    }
    if (from === -1) return false;
    const to = from + quote.length;

    const touched = spans.filter((s) => s.end > from && s.start < to);
    let lastMark = null;
    for (const s of touched) {
      const a = Math.max(0, from - s.start);
      const b = Math.min(s.node.data.length, to - s.start);
      let target = s.node;
      if (b < target.data.length) target.splitText(b);
      // splitText returns a NEW node for the tail, so the piece to wrap is that
      // return value — reading s.node again would give the untouched head.
      if (a > 0) target = target.splitText(a);
      const mark = document.createElement('mark');
      mark.className = 'tdcr-hl';
      mark.dataset.tdcr = id;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      lastMark = mark;
    }
    if (!lastMark) return false;

    // The badge belongs immediately after the highlight, inline. Hanging it off
    // the original text node's parent would drop it below the whole paragraph.
    const badge = document.createElement('span');
    badge.className = 'tdcr-badge';
    badge.dataset.tdcr = id;
    badge.textContent = '💬';
    lastMark.after(badge);
    return true;
  };

  /**
   * What kind of thing a passage sits in, innermost first.
   *
   * Named in plain words rather than tag names, because "callout #2" tells the
   * person fixing it where to look and "div" does not. The order matters: an
   * admonition title is a plain <div>, so matching on tags alone found nothing
   * at all and the location line vanished from the export.
   */
  const KINDS = [
    { sel: 'pre', name: 'code block' },
    { sel: '.theme-admonition', name: 'callout' },
    { sel: 'table', name: 'table' },
    { sel: 'figure', name: 'figure' },
    { sel: 'li', name: 'list item' },
    { sel: 'blockquote', name: 'quote' },
    { sel: 'h1, h2, h3, h4, h5, h6', name: 'heading' },
    { sel: 'figcaption', name: 'caption' },
    { sel: 'td, th', name: 'table cell' },
    { sel: 'p', name: 'paragraph' },
  ];

  const blockOf = (root, node) => {
    const start = node.nodeType === 1 ? node : node.parentElement;
    if (!start) return { name: '', index: 0 };
    // Innermost wins, so a paragraph inside an admonition reports the paragraph
    // only if nothing more specific encloses it more tightly.
    let best = null;
    for (const kind of KINDS) {
      const el = start.closest(kind.sel);
      if (!el || !root.contains(el)) continue;
      if (!best || best.el.contains(el)) best = { el, kind };
    }
    if (!best) return { name: '', index: 0 };
    return {
      name: best.kind.name,
      index: [...root.querySelectorAll(best.kind.sel)].indexOf(best.el) + 1,
    };
  };

  /** Every heading above a passage, outermost first: "Section › Subsection". */
  const trailOf = (node) => {
    const found = new Map();
    const take = (h) => {
      const level = Number(h.tagName[1]);
      if (!found.has(level)) {
        found.set(level, { text: h.textContent.replace(/[#​]/g, '').trim(), id: h.id });
      }
    };
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      let sib = el.previousElementSibling;
      while (sib) {
        // A heading is not always a plain sibling: Docusaurus puts the page's
        // <h1> inside a <header>, so look inside a sibling as well as at it.
        if (/^H[1-6]$/.test(sib.tagName)) take(sib);
        else {
          const inner = sib.querySelectorAll?.('h1, h2, h3, h4, h5, h6');
          if (inner && inner.length > 0) take(inner[inner.length - 1]);
        }
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
    return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  /**
   * Everything needed to find this passage again in the source file.
   *
   * The source `.mdx` is hard-wrapped at about 85 columns, so searching for a
   * long quote fails the moment it crosses a line break. `words` therefore holds
   * the rarest single words of the passage — a word never straddles a wrap — and
   * the export turns them into a ready-to-run search.
   */
  const describe = (el, range, quote) => {
    const nodes = textNodes(el);
    const all = nodes.map((n) => n.data).join('');

    /*
     * The offset has to be measured in the same text `all` is built from.
     * range.toString() returns the RENDERED text — whitespace collapsed, and
     * transformed by CSS — so using its length to index into the raw node data
     * drifts further with every paragraph above the selection. That put the
     * recorded context somewhere it never was, and could make the highlight
     * land on a different occurrence than the one the reviewer marked.
     */
    let offset = -1;
    let acc = 0;
    for (const n of nodes) {
      if (n === range.startContainer) {
        offset = acc + range.startOffset;
        break;
      }
      acc += n.data.length;
    }
    // A selection starting on an element boundary has no text node to match;
    // the first occurrence of the quote is the best available answer.
    if (offset < 0) offset = Math.max(0, all.indexOf(quote));

    let nth = 0;
    let at = all.indexOf(quote);
    while (at !== -1 && at < offset) {
      nth++;
      at = all.indexOf(quote, at + 1);
    }

    const block = blockOf(el, range.startContainer);

    /*
     * A phrase, not a bag of words — "sequence" alone matches half the file.
     * The words are joined with \s+ and the command carries -U, so the match
     * walks straight through the line breaks the hard-wrapped source is full
     * of. Six words is enough to be unique and short enough to stay readable.
     */
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens = quote.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const search = tokens.map(esc).join('\\s+');

    // The page's text is concatenated without separators so that offsets match
    // what wrapQuote sees. That is right for arithmetic and wrong for reading —
    // headings run into paragraphs and anchor markers come along — so the human
    // context is tidied separately.
    const clean = (s) => s.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

    return {
      nth,
      trail: trailOf(range.startContainer),
      block: block.name,
      blockIndex: block.index,
      search,
      before: clean(all.slice(Math.max(0, offset - 60), offset)),
      after: clean(all.slice(offset + quote.length, offset + quote.length + 60)),
    };
  };

  // -------------------------------------------------------------------- UI

  let pop = null;
  const hidePop = () => {
    pop?.remove();
    pop = null;
  };

  const modal = (title, quote, initial, onSave, onRemove) => {
    const back = document.createElement('div');
    back.id = 'tdcr-modal';
    back.innerHTML = `
      <div class="tdcr-card">
        <h3></h3>
        <blockquote></blockquote>
        <textarea placeholder="${T.placeholder}"></textarea>
        <div class="tdcr-row">
          ${onRemove ? `<button class="tdcr-btn tdcr-danger" data-a="rm">${T.remove}</button>` : ''}
          <button class="tdcr-btn" data-a="no">${T.cancel}</button>
          <button class="tdcr-btn tdcr-primary" data-a="ok">${T.save}</button>
        </div>
      </div>`;
    back.querySelector('h3').textContent = title;
    back.querySelector('blockquote').textContent = quote;
    const area = back.querySelector('textarea');
    area.value = initial ?? '';
    document.body.appendChild(back);
    area.focus();

    const close = () => {
      back.remove();
    };
    back.addEventListener('click', (e) => {
      const a = e.target.dataset?.a;
      if (e.target === back || a === 'no') close();
      if (a === 'rm') {
        onRemove();
        close();
      }
      if (a === 'ok' && area.value.trim()) {
        onSave(area.value.trim());
        close();
      }
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && area.value.trim()) {
        onSave(area.value.trim());
        close();
      }
      if (e.key === 'Escape') close();
    });
  };

  const add = (entry) => {
    const list = read();
    list.push(entry);
    write(list);
    refresh();
  };

  const remove = (id) => {
    write(read().filter((c) => c.id !== id));
    document.querySelectorAll(`[data-tdcr="${id}"]`).forEach((el) => {
      if (el.classList.contains('tdcr-badge')) el.remove();
      else el.replaceWith(...el.childNodes);
    });
    refresh();
  };

  const openExisting = (id) => {
    const entry = read().find((c) => c.id === id);
    if (!entry) return;
    modal(
      entry.kind === 'image' ? T.image : T.heading,
      entry.quote,
      entry.comment,
      (text) => {
        write(read().map((c) => (c.id === id ? { ...c, comment: text } : c)));
        refresh();
      },
      () => {
        remove(id);
      },
    );
  };

  // ------------------------------------------------------- text selection

  document.addEventListener('mouseup', (e) => {
    // Releasing over the document itself gives a target with no closest().
    if (e.target?.closest?.('#tdcr-bar, #tdcr-list, #tdcr-modal, #tdcr-pop')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const quote = sel ? sel.toString().trim() : '';
      const el = root();
      hidePop();
      if (!sel || sel.isCollapsed || quote.length < 2 || !el) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;

      const rect = range.getBoundingClientRect();
      pop = document.createElement('button');
      pop.id = 'tdcr-pop';
      pop.textContent = T.comment;
      pop.style.top = `${String(rect.top + window.scrollY - 40)}px`;
      pop.style.left = `${String(rect.left + window.scrollX)}px`;
      pop.addEventListener('click', () => {
        const where = describe(el, range, quote);
        hidePop();
        modal(T.heading, quote, '', (text) => {
          const id = `c${String(Date.now())}${String(Math.floor(performance.now() % 1000))}`;
          add({
            id,
            kind: 'text',
            url: location.pathname,
            title: document.title,
            source: sourceOf(location.pathname),
            quote,
            comment: text,
            ...where,
          });
          sel.removeAllRanges();
          wrapQuote(el, quote, where.nth, id);
        });
      });
      document.body.appendChild(pop);
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#tdcr-pop')) hidePop();
  });

  // --------------------------------------------------------------- images

  const armImages = () => {
    const el = root();
    if (!el) return;
    for (const img of el.querySelectorAll('img')) {
      if (img.parentElement?.classList.contains('tdcr-img-wrap')) continue;
      const wrap = document.createElement('span');
      wrap.className = 'tdcr-img-wrap';
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
      const btn = document.createElement('button');
      btn.className = 'tdcr-img-btn';
      btn.textContent = `💬 ${T.comment}`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const src = img.getAttribute('src') ?? '';
        const existing = read().find((c) => c.kind === 'image' && c.quote === src && c.url === location.pathname);
        if (existing) {
          openExisting(existing.id);
          return;
        }
        modal(T.image, src, '', (text) => {
          add({
            id: `c${String(Date.now())}`,
            kind: 'image',
            url: location.pathname,
            title: document.title,
            source: sourceOf(location.pathname),
            quote: src,
            nth: 0,
            trail: trailOf(img),
            block: 'img',
            blockIndex: [...(root()?.querySelectorAll('img') ?? [])].indexOf(img) + 1,
            // The file name alone is enough to find the <Figure> that uses it.
            search: (src.split('/').pop() ?? src).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            before: '',
            after: '',
            comment: text,
          });
          wrap.classList.add('tdcr-commented');
        });
      });
      wrap.appendChild(btn);
    }
  };

  // ----------------------------------------------------------------- export

  const markdown = (list) => {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const bySource = new Map();
    for (const c of list) {
      const key = c.source ?? c.url;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(c);
    }
    const out = [
      '# TDC documentation review',
      '',
      `Collected ${stamp} · ${String(list.length)} ${plural(list.length)} across ${String(bySource.size)} page(s)`,
      '',
      'Make the edits in the file named by each section heading — that is the page',
      'source, not the generated copy under `docs/`.',
      '',
    ];
    for (const [source, items] of bySource) {
      out.push(
        '---',
        '',
        `## \`${source}\``,
        '',
        `Page: \`${items[0].url}\` — ${items[0].title.split('|')[0].trim()}`,
        '',
      );
      items.forEach((c, i) => {
        // `section` is what an earlier version of this layer stored. Notes made
        // with it are still in reviewers' browsers, and dropping them silently
        // would print "(no section)" over a perfectly good heading.
        const trail = (c.trail ?? []).map((h) => h.text).filter(Boolean);
        if (trail.length === 0 && c.section) trail.push(c.section);
        out.push(`### ${String(i + 1)}. ${trail.join(' › ') || '(no section)'}`, '');

        if (c.kind === 'image') {
          out.push(`**Image:** \`${c.quote}\``, '');
        } else {
          const place = [
            c.block ? `${c.block} №${String(c.blockIndex)}` : '',
            (c.nth ?? 0) > 0 ? `occurrence ${String((c.nth ?? 0) + 1)} of the phrase` : '',
          ]
            .filter(Boolean)
            .join(', ');
          if (place) out.push(`**Where:** ${place}`, '');
          out.push(`> ${c.quote.replace(/\n+/g, '\n> ')}`, '');
          if (c.before || c.after) {
            out.push(`Context: …${c.before} **[SELECTED]** ${c.after}…`, '');
          }
        }

        // Two reasons the search looks the way it does. The source is
        // hard-wrapped, so it goes word by word — a phrase dies on the first
        // line break. And it is case-insensitive, because CSS decides some of
        // what a reader sees: an admonition title renders in capitals while the
        // source has it in sentence case, so the quote captured from the page
        // would never match the file.
        const search = c.search ?? (c.words ?? []).join('|');
        if (search) {
          out.push('```bash', `rg -niU "${search}" ${source}`, '```', '');
        }
        if (c.trail?.[c.trail.length - 1]?.id) {
          out.push(`Section on the site: \`${c.url}#${c.trail[c.trail.length - 1].id}\``, '');
        }

        out.push(`**${c.comment}**`, '');
      });
    }
    out.push('---', '', '<details><summary>The same data as JSON</summary>', '', '```json');
    out.push(JSON.stringify(list, null, 2), '```', '', '</details>', '');
    return out.join('\n');
  };

  const download = () => {
    const list = read();
    if (list.length === 0) return;
    const blob = new Blob([markdown(list)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tdc-review-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  // -------------------------------------------------------------------- bar

  let bar = null;
  let panel = null;

  const buildBar = () => {
    bar = document.createElement('div');
    bar.id = 'tdcr-bar';
    bar.innerHTML =
      `<span class="tdcr-count"></span>` +
      `<button class="tdcr-btn" data-a="list">${T.list}</button>` +
      `<button class="tdcr-btn tdcr-primary" data-a="save">${T.export}</button>` +
      `<button class="tdcr-btn tdcr-danger" data-a="clear">${T.clear}</button>`;
    bar.addEventListener('click', (e) => {
      const a = e.target.dataset?.a;
      if (a === 'save') download();
      if (a === 'list') togglePanel();
      if (a === 'clear' && confirm(T.confirm)) {
        write([]);
        location.reload();
      }
    });
    document.body.appendChild(bar);
  };

  const togglePanel = () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    const list = read();
    panel = document.createElement('div');
    panel.id = 'tdcr-list';
    if (list.length === 0) panel.textContent = T.none;
    for (const c of list) {
      const item = document.createElement('div');
      item.className = 'tdcr-item';
      const where = document.createElement('a');
      where.className = 'tdcr-where';
      // `href` is a sink: a stored `javascript:` value runs when the reviewer
      // clicks it. What we store is a `location.pathname`, which starts with
      // "/" on every real page — but "on every real page" is the wrong kind of
      // guarantee for a sink, and the store is a JSON file a reviewer can edit
      // or be handed.
      //
      // So the stored string never reaches the attribute. It is resolved
      // against a base that belongs to nothing, and only a result that stayed
      // on that base becomes a link — rebuilt from the parts the URL parser
      // produced. `javascript:` and `//evil.com` both land on a different
      // origin and are dropped. The result is relative, so it still resolves
      // whether the bundle is opened over http or straight off disk.
      let href = null;
      try {
        const parsed = new URL(String(c.url ?? ''), 'https://review.invalid/');
        if (parsed.origin === 'https://review.invalid') {
          href = parsed.pathname + parsed.search + parsed.hash;
        }
      } catch {
        href = null; // not something the URL parser accepts: not a link
      }
      if (href) where.href = href;
      where.textContent = `${c.title.split('|')[0].trim()} — ${c.section || '—'}`;
      const quote = document.createElement('div');
      quote.className = 'tdcr-quote';
      quote.textContent = c.quote.length > 90 ? `${c.quote.slice(0, 90)}…` : c.quote;
      const text = document.createElement('div');
      text.textContent = c.comment;
      item.append(where, quote, text);
      panel.appendChild(item);
    }
    document.body.appendChild(panel);
  };

  const refresh = () => {
    const n = read().length;
    if (bar) bar.querySelector('.tdcr-count').textContent = `${String(n)} ${plural(n)}`;
    if (panel) {
      panel.remove();
      panel = null;
      togglePanel();
    }
  };

  /** Re-mark the passages already commented on this page. */
  const restore = () => {
    const el = root();
    if (!el) return;
    for (const c of read()) {
      if (c.url !== location.pathname) continue;
      if (c.kind === 'image') {
        for (const wrap of el.querySelectorAll('.tdcr-img-wrap')) {
          if (wrap.querySelector('img')?.getAttribute('src') === c.quote) {
            wrap.classList.add('tdcr-commented');
          }
        }
      } else if (!document.querySelector(`[data-tdcr="${c.id}"]`)) {
        wrapQuote(el, c.quote, c.nth ?? 0, c.id);
      }
    }
  };

  document.addEventListener('click', (e) => {
    const id = e.target.closest('[data-tdcr]')?.dataset.tdcr;
    if (id) openExisting(id);
  });

  const mount = () => {
    if (!bar) buildBar();
    armImages();
    restore();
    refresh();
  };

  document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('load', mount);
  if (document.readyState !== 'loading') mount();

  /*
   * This is a React site. It hydrates after the static HTML loads and rebuilds
   * the article, throwing away any image wrapper or highlight put there first —
   * which is why marks vanished until this observer existed. Re-arming on every
   * settled DOM change covers hydration and in-page navigation alike.
   *
   * It converges rather than looping: arming an image already wrapped, or
   * restoring a mark already present, changes nothing, so the observer that our
   * own work triggers finds nothing left to do.
   */
  let settle = 0;
  new MutationObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      armImages();
      restore();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true });

  // Route changes also mean the open list is stale.
  let last = location.pathname;
  setInterval(() => {
    if (location.pathname !== last) {
      last = location.pathname;
      panel?.remove();
      panel = null;
      setTimeout(mount, 150);
    }
  }, 300);
})();
