/* رستگار نت — ابزارهای مشترک سمت مرورگر */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /** ساخت امن عنصر DOM (بدون innerHTML، تا متن کاربران هرگز به‌عنوان HTML تفسیر نشود) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) add(c);
        else el.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    })(Array.prototype.slice.call(arguments, 2));
    return el;
  }

  function icon(name, extra) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'i' + (extra ? ' ' + extra : ''));
    var u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }

  function api(url, method, body) {
    var opts = {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'X-RN': '1' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || 'خطایی رخ داد. دوباره تلاش کنید.');
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function toast(msg, kind) {
    var box = $('#toasts');
    if (!box) return;
    var t = h('div', { class: 'toast ' + (kind || '') }, msg);
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 3600);
    setTimeout(function () { t.remove(); }, 4100);
  }

  /** پنجرهٔ پرسش/تأیید. اگر کاربر انصراف دهد null برمی‌گرداند، وگرنه شیء مقادیر فیلدها. */
  function askDialog(o) {
    var dlg = $('#dlg'), form = $('#dlg-form'), box = $('#dlg-fields');
    $('#dlg-title').textContent = o.title || '';
    var txt = $('#dlg-text');
    txt.textContent = o.text || '';
    txt.hidden = !o.text;
    box.replaceChildren();
    var inputs = {};
    (o.fields || []).forEach(function (f) {
      var input = h('input', {
        type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '',
        maxlength: f.maxlength || 64, required: f.required !== false, autocomplete: 'off',
        dir: f.dir || null, class: f.dir === 'ltr' ? 'ltr-input' : null
      });
      inputs[f.name] = input;
      box.appendChild(h('label', { class: 'field' }, h('span', null, f.label), input));
    });
    var okBtn = $('#dlg-ok');
    okBtn.textContent = o.ok || 'تأیید';
    okBtn.className = 'btn ' + (o.danger ? 'danger' : 'primary');

    return new Promise(function (resolve) {
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        form.removeEventListener('submit', onSubmit);
        $('#dlg-cancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onCancel);
        if (dlg.open) dlg.close();
        resolve(val);
      }
      function onSubmit(e) {
        e.preventDefault();
        var vals = {};
        Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value.trim(); });
        finish(vals);
      }
      function onCancel() { finish(null); }
      form.addEventListener('submit', onSubmit);
      $('#dlg-cancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onCancel);
      dlg.showModal();
      var first = box.querySelector('input');
      if (first) { first.focus(); first.select(); } else { okBtn.focus(); }
    });
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return 'کمتر از ۱ دقیقه';
    var m = Math.floor(sec / 60), hh = Math.floor(m / 60);
    m = m % 60;
    return (hh ? hh + ' ساعت' + (m ? ' و ' : '') : '') + (m ? m + ' دقیقه' : '');
  }

  var ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  function genPassword(n) {
    n = n || 6;
    var arr = new Uint32Array(n), out = '';
    crypto.getRandomValues(arr);
    for (var i = 0; i < n; i++) out += ALPHABET[arr[i] % ALPHABET.length];
    return out;
  }

  window.RN = { $: $, h: h, icon: icon, api: api, toast: toast, askDialog: askDialog, fmtTime: fmtTime, fmtDur: fmtDur, genPassword: genPassword };
})();
