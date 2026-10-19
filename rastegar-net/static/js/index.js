/* صفحهٔ ورود دانش‌آموزان و صفحهٔ ورود مدیران */
(function () {
  'use strict';
  var RN = window.RN, $ = RN.$;

  var toggle = $('#pw-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var input = toggle.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = !msg;
  }

  /* ── ورود دانش‌آموز ── */
  var form = $('#login-form');
  if (form) {
    var doors = Array.prototype.slice.call(document.querySelectorAll('.door'));
    var title = $('#login-title'), hint = $('#login-hint'), btn = $('#login-btn');
    var err = $('#login-error'), nameInput = $('#login-name'), passInput = $('#login-pass');
    var room = '';

    function selectRoom(r, focus) {
      room = r;
      doors.forEach(function (d) {
        var on = d.dataset.room === r;
        d.classList.toggle('is-selected', on);
        d.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      title.textContent = 'ورود به کلاس ' + r;
      hint.hidden = true;
      try { localStorage.setItem('rn_room', r); } catch (e) { /* ignore */ }
      if (focus) nameInput.focus();
    }

    doors.forEach(function (d) {
      d.addEventListener('click', function () { selectRoom(d.dataset.room, true); });
    });

    var preset = '';
    doors.forEach(function (d) { if (d.classList.contains('is-selected')) preset = d.dataset.room; });
    if (!preset) { try { preset = localStorage.getItem('rn_room') || ''; } catch (e) { /* ignore */ } }
    if (preset && doors.some(function (d) { return d.dataset.room === preset; })) selectRoom(preset, false);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      showError(err, '');
      if (!room) { showError(err, 'ابتدا کلاس خود را از ساختمان انتخاب کنید.'); return; }
      if (!nameInput.value.trim() || !passInput.value) { showError(err, 'نام و رمز عبور را وارد کنید.'); return; }
      btn.disabled = true;
      RN.api('/api/student/login', 'POST', { room: room, name: nameInput.value, password: passInput.value })
        .then(function (d) { location.href = d.redirect; })
        .catch(function (ex) { showError(err, ex.message); btn.disabled = false; passInput.select(); });
    });
  }

  /* ── ورود مدیر ── */
  var aform = $('#admin-login-form');
  if (aform) {
    var aerr = $('#admin-error'), abtn = $('#admin-btn'), apass = $('#admin-pass');
    aform.addEventListener('submit', function (e) {
      e.preventDefault();
      showError(aerr, '');
      if (!apass.value) { showError(aerr, 'رمز عبور را وارد کنید.'); return; }
      abtn.disabled = true;
      RN.api('/api/admin/login', 'POST', { password: apass.value })
        .then(function (d) { location.href = d.redirect; })
        .catch(function (ex) { showError(aerr, ex.message); abtn.disabled = false; apass.select(); });
    });
  }
})();
