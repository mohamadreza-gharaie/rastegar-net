/* رستگار نت — پنل مدیریت (مدیران و معلمان) */
(function () {
  'use strict';

  var RN = window.RN, h = RN.h, icon = RN.icon, toast = RN.toast, $ = RN.$;
  var KICK = parseInt($('.admin-main').dataset.kick, 10) || 30;

  var PERMS = [
    ['mic', 'میکروفن دانش‌آموزان'],
    ['cam', 'دوربین دانش‌آموزان'],
    ['chat', 'گفتگو (چت)'],
    ['screen', 'اشتراک صفحه دانش‌آموزان']
  ];

  var state = null;
  var tab = 'overview';
  var usersRoom = null, attRoom = null;
  var lastCreated = [];
  var reportTimer = null, lastSig = '';

  function room(r) { return state && state.rooms.filter(function (x) { return x.room === r; })[0]; }

  /* ───────── اتصال زنده ───────── */
  var socket = io({ transports: ['websocket', 'polling'] });
  function setConn(ok) {
    var c = $('#conn');
    c.className = 'conn ' + (ok ? 'ok' : 'bad');
    c.querySelector('span').textContent = ok ? 'زنده' : 'قطع شد…';
  }
  socket.on('connect', function () { setConn(true); socket.emit('admin_watch'); });
  socket.on('disconnect', function () { setConn(false); });
  socket.on('admin_state', function (s) { state = s; render(); });

  RN.api('/api/admin/state').then(function (s) { if (!state) { state = s; render(); } })
    .catch(function (e) { if (e.status === 401) location.href = '/admin/login'; });

  function guard(p) {
    return p.catch(function (e) {
      if (e.status === 401) { location.href = '/admin/login'; return null; }
      toast(e.message, 'warn');
      return null;
    });
  }

  /* ───────── زبانه‌ها ───────── */
  function switchTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tabpane').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
    if (name === 'attendance') loadReport();
    render();
  }
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.dataset.tab); });
  });

  $('#logout').addEventListener('click', function () {
    RN.api('/api/admin/logout', 'POST').then(function () { location.href = '/admin/login'; }, function () { location.href = '/admin/login'; });
  });

  function render() {
    if (!state) return;
    if (!usersRoom) usersRoom = state.rooms[0].room;
    if (!attRoom) attRoom = state.rooms[0].room;
    renderOverview();
    renderUsers();
    renderAttendance();
  }

  /* ───────── نمای کلی ───────── */
  function stat(n, label) {
    return h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, label));
  }

  function switchRow(r, p) {
    var on = !!r.settings[p[0]];
    return h('div', { class: 'sw-row' },
      h('span', null, p[1]),
      h('button', {
        type: 'button', class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': p[1] + ' کلاس ' + r.room,
        onclick: function () { socket.emit('ctl_setting', { room: r.room, key: p[0], value: !on }); }
      })
    );
  }

  function roomCard(r) {
    var live = r.teachers.length > 0;
    return h('article', { class: 'room-card' + (live ? ' is-live' : '') },
      h('div', { class: 'rc-head' },
        h('div', { class: 'rc-num' }, r.room),
        h('div', { class: 'rc-status' },
          live ? h('i', { class: 'live-dot' }) : null,
          live ? 'معلم در کلاس است' : 'معلم در کلاس نیست')
      ),
      h('div', { class: 'rc-stats' },
        stat(r.present, 'حاضر'),
        stat(Math.max(0, r.registered - r.present), 'غایب'),
        stat(r.registered, 'ثبت‌شده')
      ),
      h('div', { class: 'rc-switches' }, PERMS.map(function (p) { return switchRow(r, p); })),
      h('div', { class: 'rc-actions' },
        h('a', { class: 'btn primary small', href: '/class/' + r.room, target: '_blank', rel: 'noopener' }, icon('enter'), 'ورود به کلاس'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { usersRoom = r.room; switchTab('users'); } }, icon('users'), 'کاربران')
      )
    );
  }

  function renderOverview() {
    $('#rooms-grid').replaceChildren.apply($('#rooms-grid'), state.rooms.map(roomCard));
  }

  /* ───────── انتخاب کلاس (قرص‌ها) ───────── */
  function renderPills(box, current, onPick) {
    box.replaceChildren.apply(box, state.rooms.map(function (r) {
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': r.room === current ? 'true' : 'false',
        class: 'pill' + (r.room === current ? ' is-active' : '') + (r.teachers.length ? ' is-live' : ''),
        onclick: function () { onPick(r.room); }
      }, h('b', null, r.room), h('small', null, r.present + '/' + r.registered));
    }));
  }

  /* ───────── کاربران ───────── */
  function statusChip(u) {
    if (u.status === 'present') return h('span', { class: 'status st-present' }, 'حاضر · از ' + RN.fmtTime(u.since));
    if (u.status === 'banned') return h('span', { class: 'status st-banned' }, 'اخراج تا ' + RN.fmtTime(u.until));
    return h('span', { class: 'status st-absent' }, 'غایب');
  }

  function iconBtn(name, title, fn, cls) {
    return h('button', { type: 'button', class: 'icon-btn sm ' + (cls || ''), title: title, 'aria-label': title, onclick: fn }, icon(name));
  }

  function userRow(u) {
    var acts = [];
    acts.push(iconBtn('key', 'تغییر رمز عبور', function () { changePassword(u); }));
    acts.push(iconBtn('edit', 'تغییر نام', function () { renameUser(u); }));
    if (u.status === 'present') acts.push(iconBtn('ban', 'اخراج از کلاس', function () { kickUser(u); }, 'warn'));
    if (u.status === 'banned') acts.push(iconBtn('check', 'رفع اخراج', function () { unbanUser(u); }, 'ok'));
    acts.push(iconBtn('trash', 'حذف کاربر', function () { deleteUser(u); }, 'danger'));
    return h('div', { class: 'urow' }, h('div', { class: 'uname' }, u.name), statusChip(u), h('div', { class: 'uacts' }, acts));
  }

  function renderUsers() {
    renderPills($('#users-pills'), usersRoom, function (r) { usersRoom = r; renderUsers(); });
    var r = room(usersRoom);
    $('#add-room-label').textContent = 'کلاس ' + usersRoom;
    $('#users-count').textContent = r.users.length ? String(r.users.length) : '';
    var box = $('#users-table');
    if (!r.users.length) {
      box.replaceChildren(h('p', { class: 'empty' }, 'هنوز کاربری برای کلاس ' + usersRoom + ' ثبت نشده است. از فرم کنار، اولین نفر را اضافه کنید.'));
    } else {
      box.replaceChildren.apply(box, r.users.map(userRow));
    }
  }

  function changePassword(u) {
    RN.askDialog({
      title: 'تغییر رمز «' + u.name + '»', text: 'رمز جدید را بنویسید یا همین رمز پیشنهادی را بپذیرید.',
      fields: [{ name: 'password', label: 'رمز عبور جدید', value: RN.genPassword(), dir: 'ltr' }], ok: 'ذخیره'
    }).then(function (v) {
      if (!v) return;
      guard(RN.api('/api/admin/users/' + u.id, 'PUT', { password: v.password })).then(function (d) {
        if (d) { toast('رمز «' + u.name + '» عوض شد.', 'ok'); showCreated([{ name: u.name, password: v.password }]); }
      });
    });
  }

  function renameUser(u) {
    RN.askDialog({ title: 'تغییر نام', fields: [{ name: 'name', label: 'نام جدید', value: u.name, maxlength: 40 }], ok: 'ذخیره' }).then(function (v) {
      if (!v) return;
      guard(RN.api('/api/admin/users/' + u.id, 'PUT', { name: v.name })).then(function (d) { if (d) toast('نام تغییر کرد.', 'ok'); });
    });
  }

  function kickUser(u) {
    RN.askDialog({ title: 'اخراج ' + u.name, text: 'از کلاس بیرون می‌شود و تا ' + KICK + ' دقیقه نمی‌تواند دوباره وارد شود.', ok: 'اخراج', danger: true }).then(function (v) {
      if (v) guard(RN.api('/api/admin/users/' + u.id + '/kick', 'POST', {})).then(function (d) { if (d) toast(u.name + ' اخراج شد.', 'ok'); });
    });
  }

  function unbanUser(u) {
    guard(RN.api('/api/admin/users/' + u.id + '/unban', 'POST', {})).then(function (d) { if (d) toast('اخراج ' + u.name + ' لغو شد.', 'ok'); });
  }

  function deleteUser(u) {
    RN.askDialog({ title: 'حذف «' + u.name + '»', text: 'این کاربر از کلاس ' + usersRoom + ' حذف می‌شود و دیگر نمی‌تواند وارد شود.', ok: 'حذف', danger: true }).then(function (v) {
      if (v) guard(RN.api('/api/admin/users/' + u.id, 'DELETE')).then(function (d) { if (d) toast('کاربر حذف شد.', 'ok'); });
    });
  }

  function addUsers(entries) {
    return guard(RN.api('/api/admin/users', 'POST', { room: usersRoom, entries: entries })).then(function (d) {
      if (!d) return null;
      d.errors.forEach(function (e) { toast((e.name ? e.name + ': ' : '') + e.error, 'warn'); });
      if (d.created.length) {
        toast(d.created.length + ' کاربر اضافه شد.', 'ok');
        showCreated(d.created);
      }
      return d;
    });
  }

  $('#gen-pass').addEventListener('click', function () { $('#add-pass').value = RN.genPassword(); });
  $('#add-pass').value = RN.genPassword();

  $('#add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#add-name').value.trim(), pass = $('#add-pass').value.trim();
    if (!name || !pass) return;
    addUsers([{ name: name, password: pass }]).then(function (d) {
      if (d && d.created.length) {
        $('#add-name').value = '';
        $('#add-pass').value = RN.genPassword();
        $('#add-name').focus();
      }
    });
  });

  $('#bulk-btn').addEventListener('click', function () {
    var entries = $('#bulk-text').value.split(/\r?\n/).map(function (line) {
      line = line.trim();
      if (!line) return null;
      var m = line.match(/^(.*?)\s*[,،\t:]\s*(\S+)$/);
      return m ? { name: m[1].trim(), password: m[2] } : { name: line, password: '' };
    }).filter(Boolean);
    if (!entries.length) { toast('هیچ نامی نوشته نشده است.', 'warn'); return; }
    addUsers(entries).then(function (d) { if (d && d.created.length) $('#bulk-text').value = ''; });
  });

  /* رمزهای ساخته‌شده (فقط همین یک‌بار قابل نمایش‌اند) */
  function showCreated(list) {
    lastCreated = list.map(function (x) { return { name: x.name, password: x.password, room: usersRoom }; });
    var box = $('#created-list');
    box.replaceChildren.apply(box, list.map(function (x) {
      return h('div', { class: 'created-item' }, h('span', { class: 'ci-name' }, x.name), h('code', { class: 'ci-pass', dir: 'ltr' }, x.password));
    }));
    $('#created-box').hidden = false;
    $('#created-box').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('#created-close').addEventListener('click', function () { $('#created-box').hidden = true; });

  $('#created-copy').addEventListener('click', function () {
    var text = lastCreated.map(function (x) { return 'کلاس ' + x.room + ' | ' + x.name + ' | ' + x.password; }).join('\n');
    var done = function () { toast('کپی شد.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('کپی نشد؛ دستی انتخاب کنید.', 'warn'); }
      ta.remove();
    }
  });

  $('#created-print').addEventListener('click', function () {
    document.body.classList.add('printing-created');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-created'); }, 500);
  });

  /* ───────── حضور و غیاب ───────── */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  $('#att-date').value = today();
  $('#att-date').max = today();
  $('#att-date').addEventListener('change', loadReport);

  function block(title, count, rows, cls) {
    return h('div', { class: 'list-block ' + (cls || '') },
      h('h4', null, title, h('span', { class: 'count-tag' }, String(count))),
      rows.length ? rows : h('p', { class: 'empty' }, 'کسی در این فهرست نیست.')
    );
  }

  function renderAttendance() {
    renderPills($('#att-pills'), attRoom, function (r) { attRoom = r; renderAttendance(); loadReport(); });
    var r = room(attRoom);
    $('#live-room-label').textContent = 'کلاس ' + attRoom;

    var present = r.users.filter(function (u) { return u.status === 'present'; });
    var absent = r.users.filter(function (u) { return u.status !== 'present'; });
    var live = $('#live-lists');
    live.replaceChildren(
      r.teachers.length ? h('p', { class: 'teachers-line' }, icon('shield'), 'معلم در کلاس: ' + r.teachers.join('، ')) : null,
      block('حاضرین', present.length, present.map(function (u) {
        return h('div', { class: 'att-row' }, h('span', { class: 'att-name' }, u.name), h('span', { class: 'att-meta' }, 'از ' + RN.fmtTime(u.since)));
      }), 'present'),
      block('غایبین', absent.length, absent.map(function (u) {
        return h('div', { class: 'att-row' }, h('span', { class: 'att-name' }, u.name),
          u.status === 'banned' ? h('span', { class: 'status st-banned' }, 'اخراج تا ' + RN.fmtTime(u.until)) : null);
      }), 'absent')
    );

    // اگر تعداد حاضران همین کلاس عوض شد، گزارش روز را تازه کن
    var sig = attRoom + ':' + r.present;
    if (tab === 'attendance' && sig !== lastSig) { lastSig = sig; clearTimeout(reportTimer); reportTimer = setTimeout(loadReport, 1200); }
    else if (tab !== 'attendance') lastSig = sig;
  }

  function loadReport() {
    var date = $('#att-date').value || today();
    var box = $('#day-report');
    guard(RN.api('/api/admin/attendance?room=' + encodeURIComponent(attRoom) + '&date=' + date + '&tz=' + new Date().getTimezoneOffset())).then(function (d) {
      if (!d || d.room !== attRoom) return;
      var pr = d.present.map(function (e) {
        return h('div', { class: 'att-row' },
          h('span', { class: 'att-name' }, e.name),
          h('span', { class: 'att-meta' }, 'ورود ' + RN.fmtTime(e.first) + ' · ' + RN.fmtDur(e.seconds) + (e.sessions > 1 ? ' · ' + e.sessions + ' بار ورود' : '')));
      });
      var ab = d.absent.map(function (e) { return h('div', { class: 'att-row' }, h('span', { class: 'att-name' }, e.name)); });
      box.replaceChildren(block('حاضر', d.present.length, pr, 'present'), block('غایب', d.absent.length, ab, 'absent'));
    });
  }
})();
