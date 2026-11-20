// Plain JS frontend. All user content is rendered with textContent (never
// innerHTML) so note titles/bodies/filenames can't inject markup.
(() => {
  const TOKEN_KEY = 'notes_token';
  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    user: null,
    notes: [],
    currentId: null,
    authMode: 'login',
  };

  // ---------------------------------------------------------------- API
  async function api(path, { method = 'GET', body, form, raw } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });

    if (res.status === 401 && state.token) {
      logout();
      throw new Error('Your session expired. Please log in again.');
    }
    if (raw) {
      if (!res.ok) throw new Error((await safeJson(res)).error || `Request failed (${res.status})`);
      return res;
    }
    if (res.status === 204) return null;
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  // ---------------------------------------------------------------- UI helpers
  function showError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  function formatDate(sqlDate) {
    // SQLite datetime('now') is UTC without a zone marker.
    const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
    return isNaN(d) ? sqlDate : d.toLocaleString();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    children.forEach((c) => node.append(c));
    return node;
  }

  function showPane(name) {
    $('placeholder').hidden = name !== 'placeholder';
    $('new-note-form').hidden = name !== 'new';
    $('note-detail').hidden = name !== 'detail';
  }

  // ---------------------------------------------------------------- Auth
  function setAuthMode(mode) {
    state.authMode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('auth-form').elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    showError($('auth-error'), '');
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const btn = $('auth-submit');
    showError($('auth-error'), '');
    btn.disabled = true;
    try {
      const data = await api(`/api/auth/${state.authMode}`, {
        method: 'POST',
        body: { email: form.elements.email.value, password: form.elements.password.value },
      });
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      state.user = data.user;
      form.reset();
      await enterApp();
    } catch (err) {
      showError($('auth-error'), err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.notes = [];
    state.currentId = null;
    localStorage.removeItem(TOKEN_KEY);
    $('app-view').hidden = true;
    $('auth-view').hidden = false;
  }

  // ---------------------------------------------------------------- Notes
  async function enterApp() {
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    $('user-email').textContent = state.user.email;
    showPane('placeholder');
    await loadNotes();
  }

  async function loadNotes() {
    const { notes } = await api('/api/notes');
    state.notes = notes;
    renderList();
  }

  function renderList() {
    const list = $('note-list');
    list.replaceChildren(
      ...state.notes.map((n) => {
        const btn = el('button', { type: 'button', className: n.id === state.currentId ? 'active' : '' }, [
          el('span', { className: 't', textContent: n.title }),
          el('span', {
            className: 'p',
            textContent: (n.attachment_count ? `📎 ${n.attachment_count} · ` : '') + (n.preview || 'No content'),
          }),
        ]);
        btn.addEventListener('click', () => openNote(n.id));
        return el('li', {}, [btn]);
      })
    );
    $('empty-list').hidden = state.notes.length > 0;
  }

  async function openNote(id) {
    try {
      const { note } = await api(`/api/notes/${id}`);
      state.currentId = note.id;
      renderList();
      renderNote(note);
      showPane('detail');
    } catch (err) {
      toast(err.message);
    }
  }

  function renderNote(note) {
    $('note-title').textContent = note.title;
    $('note-date').textContent = `Created ${formatDate(note.created_at)}`;
    $('note-body').textContent = note.body || '';
    $('note-body').classList.toggle('muted', !note.body);
    if (!note.body) $('note-body').textContent = 'No content.';
    renderAttachments(note);
    showError($('upload-error'), '');
    $('upload-form').reset();
  }

  function renderAttachments(note) {
    const list = $('attachment-list');
    list.replaceChildren(
      ...note.attachments.map((a) => {
        const dl = el('button', { type: 'button', className: 'linklike', textContent: 'Download' });
        dl.addEventListener('click', () => downloadAttachment(note.id, a));
        const rm = el('button', { type: 'button', className: 'linklike danger-text', textContent: 'Remove' });
        rm.addEventListener('click', () => removeAttachment(note.id, a));
        return el('li', {}, [
          el('span', { className: 'name', textContent: a.original_name, title: a.original_name }),
          el('span', { className: 'muted small', textContent: formatSize(a.size) }),
          dl,
          rm,
        ]);
      })
    );
    $('no-attachments').hidden = note.attachments.length > 0;
  }

  async function onNewNoteSubmit(e) {
    e.preventDefault();
    const form = e.target;
    showError($('new-note-error'), '');
    try {
      const { note } = await api('/api/notes', {
        method: 'POST',
        body: { title: form.elements.title.value, body: form.elements.body.value },
      });
      form.reset();
      await loadNotes();
      await openNote(note.id);
      toast('Note saved');
    } catch (err) {
      showError($('new-note-error'), err.message);
    }
  }

  async function deleteCurrentNote() {
    if (!state.currentId) return;
    if (!confirm('Delete this note and its attachments? This cannot be undone.')) return;
    try {
      await api(`/api/notes/${state.currentId}`, { method: 'DELETE' });
      state.currentId = null;
      showPane('placeholder');
      await loadNotes();
      toast('Note deleted');
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------- Attachments
  async function onUploadSubmit(e) {
    e.preventDefault();
    const file = $('file-input').files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    showError($('upload-error'), '');
    try {
      await api(`/api/notes/${state.currentId}/attachments`, { method: 'POST', form });
      await openNote(state.currentId);
      await loadNotes();
      toast('Attachment uploaded');
    } catch (err) {
      showError($('upload-error'), err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // Downloads go through fetch so the JWT travels in the Authorization header
  // (never in the URL), then are handed to the browser as a blob.
  async function downloadAttachment(noteId, a) {
    try {
      const res = await api(`/api/notes/${noteId}/attachments/${a.id}`, { raw: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: a.original_name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(err.message);
    }
  }

  async function removeAttachment(noteId, a) {
    if (!confirm(`Remove "${a.original_name}"?`)) return;
    try {
      await api(`/api/notes/${noteId}/attachments/${a.id}`, { method: 'DELETE' });
      await openNote(noteId);
      await loadNotes();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------- Wire up
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('auth-form').addEventListener('submit', onAuthSubmit);
  $('logout-btn').addEventListener('click', logout);
  $('new-note-btn').addEventListener('click', () => {
    state.currentId = null;
    renderList();
    showError($('new-note-error'), '');
    showPane('new');
    $('new-note-form').elements.title.focus();
  });
  $('cancel-new').addEventListener('click', () => showPane('placeholder'));
  $('new-note-form').addEventListener('submit', onNewNoteSubmit);
  $('delete-note-btn').addEventListener('click', deleteCurrentNote);
  $('upload-form').addEventListener('submit', onUploadSubmit);

  // Boot: restore the session from the stored JWT if it's still valid.
  (async () => {
    if (!state.token) return logout();
    try {
      const { user } = await api('/api/auth/me');
      state.user = user;
      await enterApp();
    } catch {
      logout();
    }
  })();
})();
