// Code that runs inside a beook exercise view (injected via CDP Runtime.evaluate).
// `pageLib` is serialized with toString(), so it must not reference anything outside itself.

function pageLib() {
  const SKIP =
    'script,style,menu,#context-menu,.exerciseNavigation,.toolbar,.mediaWidgetPlaceholder,.overlayPopupContainer';
  const FIELD_SELECTOR = [
    '.cloze[contenteditable=true]',
    '.textEntry[contenteditable=true]',
    '.editableField[contenteditable=true]',
    '.shortTextEntry[contenteditable=true]',
    '.answer-keyboard',
    'input',
    'textarea',
    'select',
    '.placeholder',
    '.placeholder-multi',
    'ul.position',
    '.fullscreenDrawing',
    'map',
    'canvas',
  ].join(',');
  const WIDGET_ROOTS = '.placeholder, .placeholder-multi, ul.position, .fullscreenDrawing';
  const POOL_ITEM = '.answer-singleuse, .answer-reusable';

  const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const isSkipped = (el) => !!el.closest(SKIP);
  const textOf = (el) => clean(el.innerText !== undefined ? el.innerText : el.textContent);

  function currentRef() {
    const re = /^(?:content-|form-)?(.+?)_\d+(?:#|$)/;
    const els = document.querySelectorAll('[id^="content-"], .uebung[id], input[name], [data-question-reference]');
    for (const el of els) {
      if (isSkipped(el)) continue;
      const key = el.dataset.questionReference || (el.matches('input') ? el.name : el.id);
      const m = re.exec(key || '');
      if (m) return m[1];
    }
    return null;
  }

  function collect() {
    const fields = [];
    const byEl = new Map();
    const groups = new Map();
    const add = (el, field) => {
      field.id = 'F' + (fields.length + 1);
      field.el = el;
      fields.push(field);
      byEl.set(el, field);
      return field;
    };

    for (const el of document.querySelectorAll(FIELD_SELECTOR)) {
      if (isSkipped(el) || byEl.has(el)) continue;
      const widget = el.closest(WIDGET_ROOTS);
      if (widget && widget !== el) continue;

      if (el.matches('input[type=radio], input[type=checkbox]')) {
        const name = el.name || el.id;
        let group = groups.get(name);
        if (!group) {
          group = add(el, { kind: el.type === 'radio' ? 'single_choice' : 'multiple_choice', options: [] });
          groups.set(name, group);
        }
        const label = el.closest('label') || (el.labels && el.labels[0]);
        group.options.push({
          id: group.id + '.' + (group.options.length + 1),
          el,
          label: label ? textOf(label) : el.value,
          checked: el.checked,
        });
        byEl.set(el, group);
        continue;
      }
      if (el.matches('input')) {
        if (/^(text|number|search|)$/.test(el.type || '')) add(el, { kind: 'text', value: el.value });
        continue;
      }
      if (el.matches('textarea')) {
        add(el, { kind: 'text', value: el.value });
        continue;
      }
      if (el.matches('select')) {
        add(el, {
          kind: 'select',
          options: [...el.options].map((o) => textOf(o)),
          value: el.selectedIndex >= 0 ? textOf(el.options[el.selectedIndex]) : '',
        });
        continue;
      }
      if (el.matches('.placeholder, .placeholder-multi')) {
        const max = el.matches('.placeholder') ? 1 : Number(el.dataset.maxAnswers || 0) || null;
        add(el, { kind: 'dropzone', value: [...el.querySelectorAll(POOL_ITEM)].map(textOf), max });
        continue;
      }
      if (el.matches('ul.position')) {
        add(el, { kind: 'order', items: [...el.children].map(textOf) });
        continue;
      }
      if (el.matches('.fullscreenDrawing, map, canvas')) {
        add(el, { kind: 'drawing' });
        continue;
      }
      // contenteditable text containers
      if (el.querySelector('.cloze, .textEntry, input, textarea, .editableField')) continue; // container of other fields
      if (el.querySelector('[contenteditable=false]')) {
        add(el, { kind: 'widget' });
        continue;
      }
      add(el, { kind: 'text', value: (el.innerText || '').replace(/ /g, ' ').trim() });
    }

    const pools = [];
    const poolItems = [];
    for (const pool of document.querySelectorAll('.answerpool')) {
      if (isSkipped(pool)) continue;
      const entry = { el: pool, items: [] };
      for (const item of pool.querySelectorAll(POOL_ITEM)) {
        if (item.closest('.placeholder, .placeholder-multi')) continue;
        const handle = { id: 'P' + (poolItems.length + 1), el: item, text: textOf(item), reusable: item.matches('.answer-reusable') };
        entry.items.push(handle);
        poolItems.push(handle);
      }
      pools.push(entry);
    }
    return { fields, byEl, pools, poolItems };
  }

  function marker(field, el) {
    switch (field.kind) {
      case 'text':
        return `⟦${field.id} = "${field.value.replace(/\n/g, ' / ')}"⟧`;
      case 'single_choice':
      case 'multiple_choice': {
        const option = field.options.find((o) => o.el === el);
        return `⟦${option.id} ${option.checked ? '☑' : '☐'}⟧ `;
      }
      case 'select':
        return `⟦${field.id} select [${field.options.join(' | ')}] = "${field.value}"⟧`;
      case 'dropzone':
        return `⟦${field.id} drop${field.max ? ' max ' + field.max : ''} = ${field.value.length ? field.value.map((v) => `"${v}"`).join(', ') : 'empty'}⟧`;
      case 'order':
        return `\n⟦${field.id} order (current order):\n${field.items.map((t, i) => `  ${field.id}.${i + 1}: ${t}`).join('\n')}\n⟧\n`;
      case 'drawing':
        return `\n⟦${field.id} drawing/image area: not fillable by text, use beook_screenshot + beook_click⟧\n`;
      case 'widget':
        return `⟦${field.id} interactive element (e.g. arrows between boxes): use beook_screenshot + beook_click. Content:⟧ `;
      default:
        return '';
    }
  }

  function render(state) {
    const poolByEl = new Map(state.pools.map((p) => [p.el, p]));
    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        out.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (el.matches(SKIP) || el.matches('.pExerciseHeader')) return;
      if (getComputedStyle(el).display === 'none') return;
      const field = state.byEl.get(el);
      if (field) {
        out.push(marker(field, el));
        if (field.kind !== 'widget') return;
      }
      const pool = poolByEl.get(el);
      if (pool) {
        const items = pool.items.map((i) => `${i.id}: "${i.text}"${i.reusable ? ' (reusable)' : ''}`).join(', ');
        out.push(`\n⟦answer pool: ${items || 'empty'}⟧\n`);
        return;
      }
      const tag = el.tagName;
      if (tag === 'BR') return void out.push('\n');
      if (tag === 'IMG') return void out.push(`[image: ${el.alt || el.src.split('/').pop()}]`);
      const block =
        /^(P|DIV|H\d|LI|UL|OL|TABLE|TBODY|TR|SECTION|ARTICLE|FORM|BLOCKQUOTE)$/.test(tag) ||
        (tag === 'LABEL' && !!el.querySelector('input[type=radio], input[type=checkbox]'));
      if (tag === 'TD' || tag === 'TH') out.push(' | ');
      if (block) out.push('\n');
      if (tag === 'LI') out.push('- ');
      for (const child of el.childNodes) walk(child);
      if (block) out.push('\n');
    };
    walk(document.body);
    return out
      .join('')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function describe() {
    const header = document.querySelector('.pExerciseHeader');
    const state = collect();
    return {
      course: document.body.dataset.courseId || null,
      ref: currentRef(),
      heading: header ? clean(header.innerText.replace(/\n+/g, ' — ')) : null,
      exerciseType: [...document.body.classList].filter((c) => !/^(beook|ilp-|hyphenate|p?[eE]xerciseContext)/.test(c)).join(' '),
      text: render(state),
      fields: state.fields.map(({ el, options, ...f }) => ({
        ...f,
        ...(options ? { options: options.map(({ el: _el, ...o }) => o) } : {}),
      })),
      pool: state.poolItems.map(({ el, ...p }) => p),
    };
  }

  function probe() {
    const header = document.querySelector('.pExerciseHeader');
    return {
      title: document.title,
      course: document.body ? document.body.dataset.courseId || null : null,
      isExercise: !!header,
      heading: header ? clean(header.innerText.replace(/\n+/g, ' — ')) : null,
      ref: header ? currentRef() : null,
    };
  }

  // --- filling -------------------------------------------------------------------------------

  const $ = window.jQuery;
  const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
  const norm = (s) => clean(String(s)).toLowerCase();

  function matchOne(candidates, wanted, getText, what) {
    const w = norm(wanted);
    let hits = candidates.filter((c) => norm(getText(c)) === w);
    if (hits.length === 0) hits = candidates.filter((c) => norm(getText(c)).startsWith(w));
    if (hits.length === 0) hits = candidates.filter((c) => norm(getText(c)).includes(w));
    if (hits.length === 0) throw new Error(`No ${what} matches "${wanted}"`);
    return hits[0];
  }

  function setText(el, value) {
    const text = String(value);
    if (el.matches('input, textarea')) {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return;
    }
    el.focus();
    if (el.matches('.cloze')) el.textContent = text;
    else el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    if ($) $(el).trigger('focusout');
    el.blur();
  }

  function setChoice(field, value, optionId) {
    const options = field.options;
    if (optionId) {
      const option = options.find((o) => o.id === optionId);
      if (!option) throw new Error(`Unknown option ${optionId}`);
      const want = value === true || value === 'true' || value === 1;
      if (option.el.checked !== want) option.el.click();
      return;
    }
    const chosen = new Set(
      asList(value).map((v) => (/^F\d+\.\d+$/.test(v) ? options.find((o) => o.id === v) : matchOne(options, v, (o) => o.label, 'option'))),
    );
    if (chosen.has(undefined)) throw new Error('Unknown option handle');
    if (field.kind === 'single_choice') {
      if (chosen.size !== 1) throw new Error('Single choice needs exactly one option');
      const [option] = chosen;
      if (!option.el.checked) option.el.click();
      return;
    }
    for (const option of options) {
      if (option.el.checked !== chosen.has(option)) option.el.click();
    }
  }

  function setSelect(el, value) {
    const option = matchOne([...el.options], value, (o) => o.text, 'select option');
    el.value = option.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setDropzone(field, value, state) {
    if (!$ || !$.fn.droppable) throw new Error('Drag & drop library not available in this view');
    const zone = field.el;
    const uebung = zone.closest('.uebung') || document.body;
    const pool = state.pools.find((p) => uebung.contains(p.el)) || state.pools[0];
    if (!pool) throw new Error('No answer pool found for this drop zone');
    const used = new Set();
    // Resolve all wanted items before moving anything around.
    const items = asList(value).map((v) => {
      if (/^P\d+$/.test(v)) {
        const handle = state.poolItems.find((p) => p.id === v);
        if (!handle) throw new Error(`Unknown pool item ${v}`);
        return handle.el;
      }
      const available = pool.items.filter((p) => p.reusable || !used.has(p.el));
      const handle = matchOne(available, v, (p) => p.text, 'pool item');
      used.add(handle.el);
      return handle.el;
    });
    // Empty the zone first: single-use answers go back to the pool, reusable copies are dropped.
    for (const child of [...zone.querySelectorAll(POOL_ITEM)]) {
      if (child.matches('.answer-reusable')) child.remove();
      else {
        child.setAttribute('style', 'position: relative');
        pool.el.appendChild(child);
      }
    }
    if (typeof window.resetMakeDraggable === 'function') window.resetMakeDraggable($());
    const drop = $(zone).droppable('option', 'drop');
    for (const item of items) drop.call(zone, $.Event('drop'), { draggable: $(item), helper: $(item) });
    if (typeof window.adjustPoolStack === 'function') window.adjustPoolStack();
  }

  function setOrder(field, value) {
    const ul = field.el;
    const lis = [...ul.children];
    const remaining = [...lis];
    const ordered = asList(value).map((v) => {
      const m = /^F\d+\.(\d+)$/.exec(v);
      const li = m ? lis[Number(m[1]) - 1] : matchOne(remaining, v, textOf, 'list item');
      if (!li || !remaining.includes(li)) throw new Error(`List item "${v}" is unknown or used twice`);
      remaining.splice(remaining.indexOf(li), 1);
      return li;
    });
    for (const li of [...ordered, ...remaining]) ul.appendChild(li);
    if ($ && $.fn.sortable) {
      try {
        $(ul).sortable('refresh');
      } catch {
        // sortable not initialised; DOM order is what gets saved
      }
    }
  }

  function store() {
    if (typeof window.socketSend === 'function' && window.ILP_LocalhostUrl) {
      window.socketSend(window.ILP_LocalhostUrl + 'storeCurrentExerciseOnFocusOut/');
      return true;
    }
    return false;
  }

  function fill(answers, expectedRef) {
    if (currentRef() !== expectedRef) throw new Error(`This view no longer shows ${expectedRef}; nothing was changed.`);
    const results = [];
    for (const answer of answers) {
      const state = collect();
      const [fieldId, optionId] = /^F\d+\.\d+$/.test(answer.field)
        ? [answer.field.split('.')[0], answer.field]
        : [answer.field, null];
      const field = state.fields.find((f) => f.id === fieldId);
      try {
        if (!field) throw new Error(`Unknown field ${answer.field}`);
        switch (field.kind) {
          case 'text':
            setText(field.el, Array.isArray(answer.value) ? answer.value.join('\n') : answer.value ?? '');
            break;
          case 'single_choice':
          case 'multiple_choice':
            setChoice(field, answer.value, optionId);
            break;
          case 'select':
            setSelect(field.el, answer.value);
            break;
          case 'dropzone':
            setDropzone(field, answer.value, state);
            break;
          case 'order':
            setOrder(field, answer.value);
            break;
          default:
            throw new Error(`Field ${field.id} (${field.kind}) cannot be filled by text; use beook_click`);
        }
        results.push({ field: answer.field, ok: true });
      } catch (err) {
        results.push({ field: answer.field, ok: false, error: String(err.message || err) });
      }
    }
    const stored = store();
    return { results, stored };
  }

  function navigate(url) {
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  function scrollToY(y) {
    window.scrollTo(0, Math.max(0, y - window.innerHeight / 2));
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }

  return { describe, probe, fill, store, navigate, scrollToY };
}

export function pageCall(fn, ...args) {
  return `(${pageLib.toString()})().${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}
