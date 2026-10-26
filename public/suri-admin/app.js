// ===== State =====
let config = {
  repo: '',
  branch: 'main',
  path: 'src/links.json',
  token: '',
};

let originalLinks = {};      // Links as fetched from GitHub
let currentLinks = {};       // Local working copy of links
let fileSha = '';             // Git blob SHA
let selectedSlugs = new Set();
let currentSort = { field: 'slug', order: 'asc' };
let editingSlug = null;
let pendingImportData = null; // Stored parsed data for import modal

const API_BASE = 'https://api.github.com';

// ===== GitHub API Helper =====
async function ghFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  console.log(`[Suri] ghFetch: ${options.method || 'GET'} ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your internet connection.');
    }
    throw new Error(`Network error: ${err.message}`);
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error('Invalid or expired Personal Access Token.');
    }
    if (res.status === 404) {
      throw new Error(body.message || `Resource not found: ${endpoint}`);
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub API rate limit exceeded. Please wait a few minutes.');
    }
    throw new Error(body.message || `GitHub API error (${res.status})`);
  }

  return res.json();
}

// ===== UTF-8 Base64 Helpers =====
function base64ToUtf8(base64Str) {
  const cleanBase64 = base64Str.replace(/\s+/g, '');
  const binaryString = atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ===== Domain & Path Resolution =====
function getBaseUrl() {
  try {
    if (window.location.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      // If served under /suri-admin, the shortener root is the path before it
      const path = window.location.pathname;
      const adminIdx = path.indexOf('/suri-admin');
      if (adminIdx !== -1) {
        const rootPath = path.substring(0, adminIdx);
        return `${window.location.origin}${rootPath}`;
      }
      return window.location.origin;
    }
  } catch (e) {}

  if (!config.repo) return window.location.origin;
  const parts = config.repo.split('/');
  if (parts.length !== 2) return window.location.origin;
  const [owner, repoName] = parts;

  if (repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner}.github.io`;
  }
  return `https://${owner}.github.io/${repoName}`;
}

function detectRepoFromLocation() {
  try {
    const host = window.location.hostname;
    const pathname = window.location.pathname.replace(/^\/|\/$/g, '');
    const segments = pathname ? pathname.split('/') : [];

    if (host.endsWith('.github.io')) {
      const user = host.replace('.github.io', '');
      if (segments.length >= 2 && segments[segments.length - 1] === 'suri-admin') {
        const repoName = segments[segments.length - 2];
        return `${user}/${repoName}`;
      } else {
        return `${user}/${user}.github.io`;
      }
    }
  } catch (e) {}
  return '';
}

function getFullShortUrl(slug) {
  const base = getBaseUrl().replace(/\/+$/, '');
  const cleanSlug = (slug === '/' || slug === '') ? '' : slug.replace(/^\/+/, '');
  return cleanSlug ? `${base}/${cleanSlug}` : `${base}/`;
}

function updateDomainPrefixUI() {
  const prefixEl = document.getElementById('slug-prefix');
  if (!prefixEl) return;
  const base = getBaseUrl().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  prefixEl.textContent = `${base}/`;
}

// ===== Auth & Auto-Login =====
function loadSavedConfig() {
  try {
    const saved = localStorage.getItem('suri-admin-config');
    if (!saved) return null;
    return JSON.parse(saved);
  } catch (e) {
    return null;
  }
}

async function initAuth() {
  const saved = loadSavedConfig();
  if (saved && saved.repo && saved.token) {
    document.getElementById('repo-input').value = saved.repo || '';
    document.getElementById('branch-input').value = saved.branch || 'main';
    document.getElementById('path-input').value = saved.path || 'src/links.json';
    document.getElementById('token-input').value = saved.token || '';

    // Auto-login attempt
    document.getElementById('reconnecting-state').hidden = false;
    document.getElementById('login-fields').hidden = true;

    try {
      await performLogin(saved.repo, saved.branch || 'main', saved.path || 'src/links.json', saved.token, true);
      toast('Welcome back! Reconnected to repository.', 'success');
    } catch (err) {
      console.warn('[Suri] Auto-login failed:', err);
      document.getElementById('reconnecting-state').hidden = true;
      document.getElementById('login-fields').hidden = false;
      const errorEl = document.getElementById('login-error');
      errorEl.textContent = `Auto-reconnect failed: ${err.message}. Please verify your token.`;
      errorEl.hidden = false;
    }
  } else {
    // If not saved, check if we can auto-fill repo from the URL
    const detected = detectRepoFromLocation();
    if (detected) {
      document.getElementById('repo-input').value = detected;
    }
  }
}

async function login() {
  const repo = document.getElementById('repo-input').value.trim();
  const branch = document.getElementById('branch-input').value.trim() || 'main';
  const path = document.getElementById('path-input').value.trim() || 'src/links.json';
  const token = document.getElementById('token-input').value.trim();
  const remember = document.getElementById('remember-token').checked;

  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;

  if (!repo || !token) {
    errorEl.textContent = 'Please fill in both the repository and access token fields.';
    errorEl.hidden = false;
    return;
  }

  if (!repo.includes('/') || repo.split('/').length !== 2) {
    errorEl.textContent = 'Repository must be formatted as "owner/repo" (e.g. yourname/yourname.github.io).';
    errorEl.hidden = false;
    return;
  }

  showLoading('Connecting to GitHub...');

  try {
    await performLogin(repo, branch, path, token, remember);
    hideLoading();
    toast('Connected successfully!', 'success');
  } catch (err) {
    hideLoading();
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

async function performLogin(repo, branch, path, token, remember) {
  config = { repo, branch, path, token };

  // 1. Verify repository access
  const repoData = await ghFetch(`/repos/${repo}`);
  console.log('[Suri] Repository verified:', repoData.full_name);

  // 2. Fetch links.json file
  await fetchLinks();

  // 3. Save config if remember checked
  if (remember) {
    localStorage.setItem('suri-admin-config', JSON.stringify(config));
  } else {
    localStorage.removeItem('suri-admin-config');
  }

  // 4. Update UI screen
  document.getElementById('login-screen').hidden = true;
  document.getElementById('dashboard-screen').hidden = false;
  document.getElementById('repo-badge').textContent = repo;
  updateDomainPrefixUI();
}

function logout() {
  showConfirmModal({
    title: 'Log out',
    message: hasChanges()
      ? 'You have unsaved changes. Logging out will discard them. Are you sure?'
      : 'Are you sure you want to log out of Suri Admin?',
    confirmText: 'Log Out',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      localStorage.removeItem('suri-admin-config');
      config = { repo: '', branch: 'main', path: 'src/links.json', token: '' };
      originalLinks = {};
      currentLinks = {};
      selectedSlugs.clear();
      editingSlug = null;
      fileSha = '';

      document.getElementById('dashboard-screen').hidden = true;
      document.getElementById('login-screen').hidden = false;
      document.getElementById('reconnecting-state').hidden = true;
      document.getElementById('login-fields').hidden = false;
      document.getElementById('token-input').value = '';
      document.getElementById('login-error').hidden = true;
      updateChangesBar();
      toast('Logged out', 'info');
    }
  });
}

// ===== Fetch Links =====
async function fetchLinks() {
  try {
    const data = await ghFetch(`/repos/${config.repo}/contents/${config.path}?ref=${config.branch}`);
    fileSha = data.sha;

    const decoded = base64ToUtf8(data.content);
    try {
      originalLinks = JSON.parse(decoded);
    } catch (e) {
      originalLinks = {};
    }
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('not found')) {
      // File doesn't exist yet in the repo
      console.warn(`[Suri] ${config.path} not found. Initializing empty links.`);
      fileSha = '';
      originalLinks = {};
    } else {
      throw err;
    }
  }

  currentLinks = { ...originalLinks };
  selectedSlugs.clear();
  editingSlug = null;
  renderLinks();
  updateStats();
  updateChangesBar();
}

async function refreshLinks() {
  if (hasChanges()) {
    showConfirmModal({
      title: 'Refresh Links',
      message: 'You have unsaved changes. Refreshing will overwrite them with the latest version from GitHub. Continue?',
      confirmText: 'Discard & Refresh',
      confirmClass: 'btn-danger',
      onConfirm: async () => {
        await doRefresh();
      }
    });
  } else {
    await doRefresh();
  }
}

async function doRefresh() {
  showLoading('Refreshing from GitHub...');
  try {
    await fetchLinks();
    toast('Links refreshed successfully', 'success');
  } catch (err) {
    toast(`Failed to refresh: ${err.message}`, 'error');
  }
  hideLoading();
}

// ===== Changes & Stats Calculation =====
function hasChanges() {
  return JSON.stringify(currentLinks) !== JSON.stringify(originalLinks);
}

function getChangesSummary() {
  const currentKeys = Object.keys(currentLinks);
  const originalKeys = Object.keys(originalLinks);

  const added = currentKeys.filter(k => !(k in originalLinks));
  const removed = originalKeys.filter(k => !(k in currentLinks));
  const modified = currentKeys.filter(k => k in originalLinks && currentLinks[k] !== originalLinks[k]);

  return { added, removed, modified, totalCount: currentKeys.length };
}

function updateStats() {
  const summary = getChangesSummary();
  const totalEl = document.getElementById('stat-total');
  const newEl = document.getElementById('stat-new');
  const modEl = document.getElementById('stat-modified');
  const delEl = document.getElementById('stat-deleted');

  if (totalEl) totalEl.textContent = summary.totalCount;
  if (newEl) newEl.textContent = summary.added.length;
  if (modEl) modEl.textContent = summary.modified.length;
  if (delEl) delEl.textContent = summary.removed.length;
}

function updateChangesBar() {
  const bar = document.getElementById('changes-bar');
  if (!bar) return;

  if (!hasChanges()) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  const { added, removed, modified } = getChangesSummary();
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (modified.length) parts.push(`${modified.length} modified`);
  if (removed.length) parts.push(`${removed.length} removed`);

  document.getElementById('changes-count').textContent = parts.join(', ') || 'Unsaved changes';
}

function discardChanges() {
  showConfirmModal({
    title: 'Discard Changes',
    message: 'Are you sure you want to discard all unsaved edits and additions?',
    confirmText: 'Discard All',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      currentLinks = { ...originalLinks };
      selectedSlugs.clear();
      editingSlug = null;
      renderLinks();
      updateStats();
      updateChangesBar();
      toast('All unsaved changes were discarded', 'info');
    }
  });
}

// ===== URL Validation & Normalization =====
function normalizeSlug(slug) {
  let s = (slug || '').trim();
  if (!s || s === '/') return '/';
  // Remove leading slashes
  s = s.replace(/^\/+/, '');
  // Remove trailing slashes
  s = s.replace(/\/+$/, '');
  return s;
}

function isValidUrl(str) {
  try {
    const parsed = new URL(str);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ===== Add Link =====
function addLink() {
  const rawSlug = document.getElementById('new-slug').value;
  const rawUrl = document.getElementById('new-url').value.trim();

  if (!rawUrl) {
    toast('Please enter a destination URL.', 'error');
    document.getElementById('new-url').focus();
    return;
  }

  if (!isValidUrl(rawUrl)) {
    toast('Please enter a valid URL starting with http:// or https://', 'error');
    document.getElementById('new-url').focus();
    return;
  }

  const slug = normalizeSlug(rawSlug);

  if (slug in currentLinks) {
    toast(`Short path "/${slug === '/' ? '' : slug}" already exists. Edit the existing row instead.`, 'warning');
    return;
  }

  // Check for duplicates
  const existingWithUrl = Object.entries(currentLinks).find(([k, u]) => u.toLowerCase() === rawUrl.toLowerCase());
  if (existingWithUrl) {
    toast(`Note: "${existingWithUrl[0] === '/' ? '/' : '/' + existingWithUrl[0]}" already redirects to this same URL.`, 'info');
  }

  currentLinks[slug] = rawUrl;

  document.getElementById('new-slug').value = '';
  document.getElementById('new-url').value = '';

  renderLinks();
  updateStats();
  updateChangesBar();

  // Scroll to row or highlight
  const displaySlug = slug === '/' ? '/' : `/${slug}`;
  toast(`Added ${displaySlug}`, 'success');
}

// ===== Render Links Table =====
function renderLinks() {
  const tbody = document.getElementById('links-tbody');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();

  const entries = Object.entries(currentLinks);

  // Filter
  const filtered = entries.filter(([slug, url]) => {
    return slug.toLowerCase().includes(searchTerm) || url.toLowerCase().includes(searchTerm);
  });

  // Sort
  filtered.sort(([slugA, urlA], [slugB, urlB]) => {
    let comp = 0;
    if (currentSort.field === 'slug') {
      if (slugA === '/') comp = -1;
      else if (slugB === '/') comp = 1;
      else comp = slugA.localeCompare(slugB);
    } else {
      comp = urlA.localeCompare(urlB);
    }
    return currentSort.order === 'desc' ? -comp : comp;
  });

  // Update count indicator
  const linkCountEl = document.getElementById('link-count');
  if (linkCountEl) {
    const total = entries.length;
    linkCountEl.textContent = searchTerm
      ? `${filtered.length} of ${total} link${total !== 1 ? 's' : ''}`
      : `${total} link${total !== 1 ? 's' : ''}`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    emptyState.querySelector('p').textContent = searchTerm
      ? 'No links match your search.'
      : 'No links yet. Add your first short link above!';
    updateBulkActionsUI();
    return;
  }

  emptyState.hidden = true;

  // Build rows
  tbody.innerHTML = filtered.map(([slug, url]) => {
    const isEditing = editingSlug === slug;
    const isNew = !(slug in originalLinks);
    const isModified = !isNew && originalLinks[slug] !== url;
    const isChecked = selectedSlugs.has(slug);
    const displaySlug = slug === '/' ? '/' : `/${slug}`;

    if (isEditing) {
      return `
        <tr class="editing" data-slug="${escapeHtml(slug)}">
          <td class="col-check">
            <input type="checkbox" disabled>
          </td>
          <td class="col-slug">
            <input type="text" class="edit-input edit-slug-input" id="edit-slug-field" value="${escapeHtml(slug)}" placeholder="slug">
          </td>
          <td class="col-url">
            <input type="url" class="edit-input edit-url-input" id="edit-url-field" value="${escapeHtml(url)}" placeholder="https://...">
          </td>
          <td class="col-actions">
            <div class="actions-cell">
              <button class="btn btn-primary btn-sm" id="btn-save-edit" title="Save changes (Enter)">Save</button>
              <button class="btn btn-ghost btn-sm" id="btn-cancel-edit" title="Cancel (Esc)">Cancel</button>
            </div>
          </td>
        </tr>
      `;
    }

    return `
      <tr data-slug="${escapeHtml(slug)}" class="${isNew ? 'new-row' : ''}">
        <td class="col-check">
          <input type="checkbox" class="row-checkbox" data-slug="${escapeHtml(slug)}" ${isChecked ? 'checked' : ''}>
        </td>
        <td class="col-slug">
          <span class="slug-display" ${isModified || isNew ? 'style="color: var(--warning)"' : ''}>
            ${escapeHtml(displaySlug)}
            ${isNew ? '<span class="badge-new">NEW</span>' : ''}
            ${isModified ? '<span class="badge-edited">EDITED</span>' : ''}
          </span>
        </td>
        <td class="col-url">
          <span class="url-display" title="${escapeHtml(url)}">
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>
          </span>
        </td>
        <td class="col-actions">
          <div class="actions-cell">
            <button class="btn btn-ghost btn-icon action-copy" data-slug="${escapeHtml(slug)}" title="Copy short link">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button class="btn btn-ghost btn-icon action-info" data-slug="${escapeHtml(slug)}" title="QR Code & Details">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </button>
            <button class="btn btn-ghost btn-icon action-edit" data-slug="${escapeHtml(slug)}" title="Edit link">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="btn btn-ghost btn-icon action-delete" data-slug="${escapeHtml(slug)}" title="Delete" style="color: var(--danger)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // If in edit mode, focus edit inputs
  if (editingSlug !== null) {
    const slugInput = document.getElementById('edit-slug-field');
    const urlInput = document.getElementById('edit-url-field');

    if (slugInput && urlInput) {
      const handleKey = (e) => {
        if (e.key === 'Enter') saveEdit();
        if (e.key === 'Escape') cancelEdit();
      };
      slugInput.addEventListener('keydown', handleKey);
      urlInput.addEventListener('keydown', handleKey);
      urlInput.focus();
      urlInput.select();

      document.getElementById('btn-save-edit')?.addEventListener('click', saveEdit);
      document.getElementById('btn-cancel-edit')?.addEventListener('click', cancelEdit);
    }
  }

  updateSelectAllCheckboxState(filtered.length);
  updateBulkActionsUI();
}

// ===== Inline Edit Handler =====
function startEdit(slug) {
  if (editingSlug !== null && editingSlug !== slug) {
    // Already editing another row, cancel previous
    cancelEdit();
  }
  editingSlug = slug;
  renderLinks();
}

function cancelEdit() {
  editingSlug = null;
  renderLinks();
}

function saveEdit() {
  if (editingSlug === null) return;

  const slugInput = document.getElementById('edit-slug-field');
  const urlInput = document.getElementById('edit-url-field');
  if (!slugInput || !urlInput) return;

  const newRawSlug = slugInput.value;
  const newUrl = urlInput.value.trim();

  if (!newUrl) {
    toast('URL cannot be empty.', 'error');
    urlInput.focus();
    return;
  }

  if (!isValidUrl(newUrl)) {
    toast('Please enter a valid URL (http:// or https://).', 'error');
    urlInput.focus();
    return;
  }

  const newSlug = normalizeSlug(newRawSlug);
  const oldSlug = editingSlug;

  // If slug was changed, check for conflict
  if (newSlug !== oldSlug && newSlug in currentLinks) {
    toast(`Path "/${newSlug === '/' ? '' : newSlug}" already exists.`, 'error');
    slugInput.focus();
    return;
  }

  if (newSlug !== oldSlug) {
    delete currentLinks[oldSlug];
    if (selectedSlugs.has(oldSlug)) {
      selectedSlugs.delete(oldSlug);
      selectedSlugs.add(newSlug);
    }
  }

  currentLinks[newSlug] = newUrl;
  editingSlug = null;

  renderLinks();
  updateStats();
  updateChangesBar();
  toast(`Updated /${newSlug === '/' ? '' : newSlug}`, 'success');
}

// ===== Delete Single Link =====
function deleteLink(slug) {
  const displaySlug = slug === '/' ? '/' : `/${slug}`;
  showConfirmModal({
    title: 'Delete Link',
    message: `Are you sure you want to delete ${displaySlug}?`,
    extraHtml: `<p style="font-size: 12px; color: var(--text-dim); margin-top: 8px;">Target: ${escapeHtml(currentLinks[slug] || '')}</p>`,
    confirmText: 'Delete',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      delete currentLinks[slug];
      selectedSlugs.delete(slug);
      if (editingSlug === slug) editingSlug = null;
      renderLinks();
      updateStats();
      updateChangesBar();
      toast(`Deleted ${displaySlug}`, 'info');
    }
  });
}

// ===== Bulk Operations =====
function toggleSelectSlug(slug, checked) {
  if (checked) {
    selectedSlugs.add(slug);
  } else {
    selectedSlugs.delete(slug);
  }
  updateBulkActionsUI();
}

function toggleSelectAll(checked) {
  const searchInput = document.getElementById('search-input');
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();

  const entries = Object.entries(currentLinks);
  const filtered = entries.filter(([slug, url]) => {
    return slug.toLowerCase().includes(searchTerm) || url.toLowerCase().includes(searchTerm);
  });

  if (checked) {
    filtered.forEach(([slug]) => selectedSlugs.add(slug));
  } else {
    filtered.forEach(([slug]) => selectedSlugs.delete(slug));
  }

  renderLinks();
}

function updateSelectAllCheckboxState(visibleCount) {
  const selectAllCb = document.getElementById('select-all-cb');
  if (!selectAllCb) return;

  if (visibleCount === 0) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
    return;
  }

  const searchInput = document.getElementById('search-input');
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const visibleSlugs = Object.entries(currentLinks)
    .filter(([slug, url]) => slug.toLowerCase().includes(searchTerm) || url.toLowerCase().includes(searchTerm))
    .map(([slug]) => slug);

  const selectedVisible = visibleSlugs.filter(s => selectedSlugs.has(s)).length;

  if (selectedVisible === 0) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
  } else if (selectedVisible === visibleSlugs.length) {
    selectAllCb.checked = true;
    selectAllCb.indeterminate = false;
  } else {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = true;
  }
}

function updateBulkActionsUI() {
  const bulkBar = document.getElementById('bulk-actions');
  const countEl = document.getElementById('selected-count');
  const size = selectedSlugs.size;

  if (!bulkBar || !countEl) return;

  if (size > 0) {
    bulkBar.hidden = false;
    countEl.textContent = `${size} selected`;
  } else {
    bulkBar.hidden = true;
  }
}

function bulkDelete() {
  const size = selectedSlugs.size;
  if (size === 0) return;

  showConfirmModal({
    title: 'Delete Selected Links',
    message: `Are you sure you want to delete ${size} selected link${size !== 1 ? 's' : ''}?`,
    confirmText: `Delete ${size} Links`,
    confirmClass: 'btn-danger',
    onConfirm: () => {
      selectedSlugs.forEach(slug => {
        delete currentLinks[slug];
      });
      selectedSlugs.clear();
      if (editingSlug !== null && !(editingSlug in currentLinks)) editingSlug = null;

      renderLinks();
      updateStats();
      updateChangesBar();
      toast(`Deleted ${size} links`, 'info');
    }
  });
}

function bulkExport() {
  const size = selectedSlugs.size;
  if (size === 0) return;

  const exportObj = {};
  selectedSlugs.forEach(slug => {
    if (slug in currentLinks) {
      exportObj[slug] = currentLinks[slug];
    }
  });

  const jsonStr = JSON.stringify(exportObj, null, 2);
  downloadFile(jsonStr, `suri-links-selected-${size}.json`, 'application/json');
  toast(`Exported ${size} selected links to JSON`, 'success');
}

// ===== Import / Export =====
function exportAsJson() {
  const sorted = getSortedLinksObject();
  const jsonStr = JSON.stringify(sorted, null, 2) + '\n';
  downloadFile(jsonStr, 'links.json', 'application/json');
  toast('Exported links.json', 'success');
}

function exportAsCsv() {
  const sorted = getSortedLinksObject();
  const rows = ['slug,url'];
  for (const [slug, url] of Object.entries(sorted)) {
    // Escape quotes in CSV
    const safeSlug = slug.includes(',') || slug.includes('"') ? `"${slug.replace(/"/g, '""')}"` : slug;
    const safeUrl = url.includes(',') || url.includes('"') ? `"${url.replace(/"/g, '""')}"` : url;
    rows.push(`${safeSlug},${safeUrl}`);
  }
  const csvContent = rows.join('\n') + '\n';
  downloadFile(csvContent, 'links.csv', 'text/csv');
  toast('Exported links.csv', 'success');
}

function handleJsonFileSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('Invalid JSON structure: Expected a key-value object of { "slug": "url" }');
      }

      const validLinks = {};
      let invalidCount = 0;
      for (const [rawK, rawV] of Object.entries(data)) {
        if (typeof rawV === 'string' && isValidUrl(rawV.trim())) {
          validLinks[normalizeSlug(rawK)] = rawV.trim();
        } else {
          invalidCount++;
        }
      }

      if (Object.keys(validLinks).length === 0) {
        toast('No valid URL links found in this JSON file.', 'error');
        return;
      }

      promptImportMode(validLinks, invalidCount);
    } catch (err) {
      toast(`Failed to parse JSON file: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

function handleCsvFileSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      const validLinks = {};
      let invalidCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && line.toLowerCase().startsWith('slug,url')) continue; // Skip header

        // Simple CSV splitter
        const commaIdx = line.indexOf(',');
        if (commaIdx === -1) {
          invalidCount++;
          continue;
        }

        const rawSlug = line.slice(0, commaIdx).trim().replace(/^"(.*)"$/, '$1');
        const rawUrl = line.slice(commaIdx + 1).trim().replace(/^"(.*)"$/, '$1');

        if (isValidUrl(rawUrl)) {
          validLinks[normalizeSlug(rawSlug)] = rawUrl;
        } else {
          invalidCount++;
        }
      }

      if (Object.keys(validLinks).length === 0) {
        toast('No valid URL rows found in this CSV file.', 'error');
        return;
      }

      promptImportMode(validLinks, invalidCount);
    } catch (err) {
      toast(`Failed to parse CSV file: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

function promptImportMode(newLinks, invalidCount) {
  pendingImportData = newLinks;
  const count = Object.keys(newLinks).length;
  const modal = document.getElementById('import-mode-modal');
  const msg = document.getElementById('import-mode-message');

  let text = `Found ${count} valid link${count !== 1 ? 's' : ''} to import.`;
  if (invalidCount > 0) {
    text += ` (${invalidCount} invalid entries skipped).`;
  }
  text += ' Would you like to merge with your current links or replace all?';

  msg.textContent = text;
  modal.hidden = false;
}

function applyImport(mode) {
  const modal = document.getElementById('import-mode-modal');
  modal.hidden = true;

  if (!pendingImportData) return;

  const count = Object.keys(pendingImportData).length;

  if (mode === 'replace') {
    currentLinks = { ...pendingImportData };
  } else {
    currentLinks = { ...currentLinks, ...pendingImportData };
  }

  pendingImportData = null;
  selectedSlugs.clear();
  editingSlug = null;

  renderLinks();
  updateStats();
  updateChangesBar();
  toast(`Successfully imported ${count} links (${mode})`, 'success');
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getSortedLinksObject() {
  const sorted = {};
  const keys = Object.keys(currentLinks).sort((a, b) => {
    if (a === '/') return -1;
    if (b === '/') return 1;
    return a.localeCompare(b);
  });
  for (const k of keys) {
    sorted[k] = currentLinks[k];
  }
  return sorted;
}

// ===== Deploy Workflow =====
function promptDeploy() {
  if (!hasChanges()) {
    toast('No unsaved changes to deploy.', 'info');
    return;
  }

  const { added, removed, modified } = getChangesSummary();
  const defaultMsg = `Update links: +${added.length} ~${modified.length} -${removed.length} via Suri Admin`;
  const input = document.getElementById('commit-message-input');
  if (input) input.value = defaultMsg;

  document.getElementById('deploy-modal').hidden = false;
}

async function executeDeploy() {
  document.getElementById('deploy-modal').hidden = true;
  const input = document.getElementById('commit-message-input');
  const commitMsg = (input ? input.value.trim() : '') || 'Update links via Suri Admin';

  const deployBtn = document.getElementById('deploy-btn');
  if (deployBtn) deployBtn.disabled = true;

  showLoading('Deploying changes to GitHub...');
  showDeployStatus('deploying', 'Deploying to GitHub...');

  try {
    const sorted = getSortedLinksObject();
    const contentStr = JSON.stringify(sorted, null, 2) + '\n';
    const encoded = utf8ToBase64(contentStr);

    const payload = {
      message: commitMsg,
      content: encoded,
      branch: config.branch,
    };

    if (fileSha) {
      payload.sha = fileSha;
    }

    const res = await ghFetch(`/repos/${config.repo}/contents/${config.path}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    fileSha = res.content.sha;
    originalLinks = { ...currentLinks };

    showDeployStatus('deployed', 'Deployed!');
    updateStats();
    updateChangesBar();
    renderLinks();

    const actionsUrl = `https://github.com/${config.repo}/actions`;
    toast(`Deployed! GitHub Pages will rebuild shortly. <a href="${actionsUrl}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline;">View Workflow →</a>`, 'success');

    setTimeout(() => {
      document.getElementById('deploy-status').hidden = true;
    }, 8000);
  } catch (err) {
    showDeployStatus('failed', 'Deploy failed');
    toast(`Deploy failed: ${err.message}`, 'error');
  }

  if (deployBtn) deployBtn.disabled = false;
  hideLoading();
}

function showDeployStatus(status, text) {
  const el = document.getElementById('deploy-status');
  if (!el) return;
  el.hidden = false;
  el.className = `status ${status}`;
  el.querySelector('.status-text').textContent = text;
}

// ===== QR Code & Link Info Modal =====
function showLinkInfo(slug) {
  const fullUrl = getFullShortUrl(slug);
  const destUrl = currentLinks[slug] || '';

  const modal = document.getElementById('link-info-modal');
  const urlEl = document.getElementById('link-info-url');
  const destEl = document.getElementById('link-info-dest');
  const qrEl = document.getElementById('link-info-qr');

  urlEl.textContent = fullUrl;
  destEl.textContent = `Redirects to: ${destUrl}`;

  // Generate QR code using Google Charts QR service with fallback
  qrEl.innerHTML = '';
  const qrImg = document.createElement('img');
  qrImg.width = 180;
  qrImg.height = 180;
  qrImg.alt = `QR Code for ${fullUrl}`;
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(fullUrl)}`;
  qrImg.onerror = () => {
    // If blocked or offline, show text fallback
    qrEl.innerHTML = `<div style="padding: 20px; font-size: 13px; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-sm); border: 1px dashed var(--border);">QR display unavailable offline. Short URL is ready to copy!</div>`;
  };
  qrEl.appendChild(qrImg);

  modal.hidden = false;

  const copyBtn = document.getElementById('link-info-copy');
  copyBtn.onclick = () => {
    copyToClipboard(fullUrl);
  };
}

// ===== Clipboard Copy =====
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    toast(`Copied: ${text}`, 'success');
  } catch (e) {
    toast(`Failed to copy: ${e.message}`, 'error');
  }
}

// ===== Custom Confirm Modal =====
let confirmModalCallback = null;

function showConfirmModal({ title, message, extraHtml = '', confirmText = 'Confirm', confirmClass = 'btn-danger', onConfirm }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-message').textContent = message;
  document.getElementById('confirm-modal-extra').innerHTML = extraHtml;

  const okBtn = document.getElementById('confirm-modal-ok');
  okBtn.textContent = confirmText;
  okBtn.className = `btn ${confirmClass}`;

  confirmModalCallback = onConfirm;
  modal.hidden = false;
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').hidden = true;
  confirmModalCallback = null;
}

// ===== UI Helpers =====
function showLoading(message) {
  document.getElementById('loading-message').textContent = message;
  document.getElementById('loading-overlay').hidden = false;
}

function hideLoading() {
  document.getElementById('loading-overlay').hidden = true;
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = message;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 250);
  }, 4500);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ===== Event Delegation & Listeners =====
document.addEventListener('DOMContentLoaded', () => {
  // Check auth and auto-login
  initAuth();

  // Login button
  document.getElementById('login-btn')?.addEventListener('click', login);
  document.getElementById('token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });

  // Top header actions
  document.getElementById('refresh-btn')?.addEventListener('click', refreshLinks);
  document.getElementById('logout-btn')?.addEventListener('click', logout);

  // Add Link
  document.getElementById('add-link-btn')?.addEventListener('click', addLink);
  document.getElementById('new-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLink();
  });
  document.getElementById('new-slug')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLink();
  });

  // Duplicate URL check on blur
  document.getElementById('new-url')?.addEventListener('blur', (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    const existing = Object.entries(currentLinks).find(([k, u]) => u.toLowerCase() === val.toLowerCase());
    if (existing) {
      toast(`Notice: "${existing[0] === '/' ? '/' : '/' + existing[0]}" already targets this destination URL.`, 'info');
    }
  });

  // Search input
  document.getElementById('search-input')?.addEventListener('input', () => {
    renderLinks();
  });

  // Table header sorting
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (currentSort.field === field) {
        currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.field = field;
        currentSort.order = 'asc';
      }

      // Update CSS class for arrows
      document.querySelectorAll('th.sortable').forEach(el => {
        el.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(currentSort.order === 'asc' ? 'sort-asc' : 'sort-desc');

      renderLinks();
    });
  });

  // Select all checkbox
  document.getElementById('select-all-cb')?.addEventListener('change', (e) => {
    toggleSelectAll(e.target.checked);
  });

  // Table Body Event Delegation (Actions & Checkboxes)
  document.getElementById('links-tbody')?.addEventListener('click', (e) => {
    // Checkbox click
    const cb = e.target.closest('.row-checkbox');
    if (cb) {
      const slug = cb.dataset.slug;
      toggleSelectSlug(slug, cb.checked);
      return;
    }

    // Action button clicks
    const copyBtn = e.target.closest('.action-copy');
    if (copyBtn) {
      const slug = copyBtn.dataset.slug;
      copyToClipboard(getFullShortUrl(slug));
      return;
    }

    const infoBtn = e.target.closest('.action-info');
    if (infoBtn) {
      const slug = infoBtn.dataset.slug;
      showLinkInfo(slug);
      return;
    }

    const editBtn = e.target.closest('.action-edit');
    if (editBtn) {
      const slug = editBtn.dataset.slug;
      startEdit(slug);
      return;
    }

    const deleteBtn = e.target.closest('.action-delete');
    if (deleteBtn) {
      const slug = deleteBtn.dataset.slug;
      deleteLink(slug);
      return;
    }
  });

  // Bulk actions
  document.getElementById('bulk-delete-btn')?.addEventListener('click', bulkDelete);
  document.getElementById('bulk-export-btn')?.addEventListener('click', bulkExport);

  // Dropdown toggling
  const ioBtn = document.getElementById('io-dropdown-btn');
  const ioMenu = document.getElementById('io-dropdown-menu');

  ioBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ioMenu.hidden = !ioMenu.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#io-dropdown')) {
      if (ioMenu) ioMenu.hidden = true;
    }
  });

  // Import / Export options
  document.getElementById('export-json-btn')?.addEventListener('click', () => {
    ioMenu.hidden = true;
    exportAsJson();
  });
  document.getElementById('export-csv-btn')?.addEventListener('click', () => {
    ioMenu.hidden = true;
    exportAsCsv();
  });

  document.getElementById('import-json-btn')?.addEventListener('click', () => {
    ioMenu.hidden = true;
    document.getElementById('import-json-file').click();
  });
  document.getElementById('import-csv-btn')?.addEventListener('click', () => {
    ioMenu.hidden = true;
    document.getElementById('import-csv-file').click();
  });

  document.getElementById('import-json-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleJsonFileSelect(file);
    e.target.value = '';
  });
  document.getElementById('import-csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleCsvFileSelect(file);
    e.target.value = '';
  });

  // Import mode modal
  document.getElementById('import-mode-cancel')?.addEventListener('click', () => {
    document.getElementById('import-mode-modal').hidden = true;
    pendingImportData = null;
  });
  document.getElementById('import-mode-merge')?.addEventListener('click', () => {
    applyImport('merge');
  });
  document.getElementById('import-mode-replace')?.addEventListener('click', () => {
    applyImport('replace');
  });

  // Changes Bar
  document.getElementById('discard-btn')?.addEventListener('click', discardChanges);
  document.getElementById('deploy-btn')?.addEventListener('click', promptDeploy);

  // Deploy Modal
  document.getElementById('deploy-modal-cancel')?.addEventListener('click', () => {
    document.getElementById('deploy-modal').hidden = true;
  });
  document.getElementById('deploy-modal-ok')?.addEventListener('click', executeDeploy);

  // Confirm Modal
  document.getElementById('confirm-modal-cancel')?.addEventListener('click', closeConfirmModal);
  document.getElementById('confirm-modal-ok')?.addEventListener('click', () => {
    if (confirmModalCallback) confirmModalCallback();
    closeConfirmModal();
  });

  // Link Info Modal
  document.getElementById('link-info-close')?.addEventListener('click', () => {
    document.getElementById('link-info-modal').hidden = true;
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape to close modals or cancel edit
    if (e.key === 'Escape') {
      const modals = ['confirm-modal', 'deploy-modal', 'import-mode-modal', 'link-info-modal'];
      let closedModal = false;
      for (const id of modals) {
        const el = document.getElementById(id);
        if (el && !el.hidden) {
          el.hidden = true;
          closedModal = true;
        }
      }
      if (!closedModal && editingSlug !== null) {
        cancelEdit();
      }
    }

    // Ctrl+S or Cmd+S to deploy
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (document.getElementById('dashboard-screen') && !document.getElementById('dashboard-screen').hidden) {
        e.preventDefault();
        promptDeploy();
      }
    }

    // '/' to focus search (when not in an input or textarea)
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      if (document.getElementById('dashboard-screen') && !document.getElementById('dashboard-screen').hidden) {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      }
    }
  });
});
