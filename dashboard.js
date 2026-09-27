const $ = (selector, root = document) => root.querySelector(selector);
const pageContent = $('#page-content');
const toastElement = $('#toast');
const routeTitles = {
  overview: 'Overview', tasks: 'Tasks', marketplace: 'Marketplace', products: 'Products',
  vendor: 'Vendor dashboard', gigs: 'Gigs', wallet: 'Wallet', profile: 'Profile',
  support: 'Contact support', premium: 'Premium', settings: 'Settings', admin: 'Admin'
};
const routePaths = Object.fromEntries(Object.keys(routeTitles).map((route) => [route, `/${route}`]));
let currentUser = null;
let marketplaceItems = [];
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function initials(name) {
  return String(name || 'TaskFlow').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'TF';
}

function money(cents) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(cents || 0) / 100);
}

function notify(message) {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 3200);
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: { ...(!isFormData && options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function setShellUser(user) {
  currentUser = user;
  document.querySelectorAll('[data-user-name]').forEach((element) => { element.textContent = user?.name || 'Husnain'; });
  document.querySelectorAll('[data-user-email]').forEach((element) => { element.textContent = user?.email || '@taskflow'; });
  document.querySelectorAll('[data-user-initials]').forEach((element) => { element.textContent = initials(user?.name || 'Husnain'); });
  $('[data-verified]').classList.toggle('hidden', !user?.greenTick && !user?.green_tick);
  $('[data-premium]').classList.toggle('hidden', (user?.subscriptionTier || user?.subscription_tier) !== 'premium');
  $('[data-route="admin"]').classList.toggle('hidden', !user?.isAdmin && user?.role !== 'admin');
}

function categoryOptions(categories, includeAll = false) {
  const first = includeAll ? '<option value="">All categories</option>' : '<option value="">Select category</option>';
  return first + categories.map((category) => `<option value="${escapeHtml(category.name)}">${escapeHtml(category.parentName ? `${category.parentName} / ${category.name}` : category.name)}</option>`).join('');
}

async function loadCategories() {
  try {
    const response = await api('/api/categories');
    return response.categories || [];
  } catch {
    return ['Design', 'Development', 'Marketing', 'Video', 'Writing', 'Business', 'Photography', 'Other'].map((name) => ({ name }));
  }
}

function pageFrame(route, body, eyebrow = 'Workspace') {
  $('#page-title').textContent = routeTitles[route] || 'Overview';
  $('#page-eyebrow').textContent = eyebrow;
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === route && link.classList.contains('nav-link')));
  pageContent.innerHTML = body;
  window.lucide?.createIcons();
}

function emptyState(message) {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function notificationMarkup(items) {
  return items.length ? items.slice(0, 5).map((item) => `<div class="feed-item"><span class="feed-dot"></span><p>${escapeHtml(item.body || item.kind || 'Platform update')}<small>${escapeHtml(item.kind || 'Update')} · ${new Date(item.createdAt || item.created_at || Date.now()).toLocaleString()}</small></p></div>`).join('') : emptyState('No recent notifications.');
}

function showAd(ad) {
  const slot = $('#ad-slot');
  if (!slot || !ad) return;
  const media = Array.isArray(ad.media) ? ad.media[0] : null;
  const mediaUrl = typeof media === 'string' ? media : media?.url;
  if (!mediaUrl) return;
  const safeUrl = escapeHtml(mediaUrl);
  const mediaMarkup = /^video\//i.test(typeof media === 'object' ? media.mimeType || '' : '')
    ? `<video src="${safeUrl}" autoplay muted playsinline loop></video>`
    : `<img src="${safeUrl}" alt="${escapeHtml(ad.title || 'Sponsored content')}" loading="eager">`;
  slot.innerHTML = `${mediaMarkup}<div class="ad-slot-copy"><div><strong>${escapeHtml(ad.title || 'Sponsored')}</strong><small>Sponsored · ${escapeHtml(ad.category || 'Featured')}</small></div>${ad.skip_allowed === false ? '' : '<button class="button ad-skip" type="button" disabled>Skip ad (3)</button>'}</div>`;
  slot.classList.add('is-visible');
  const skip = $('.ad-skip', slot);
  if (!skip) return;
  let seconds = 3;
  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      skip.disabled = false;
      skip.textContent = 'Skip ad';
      skip.addEventListener('click', () => slot.classList.remove('is-visible'), { once: true });
    } else skip.textContent = `Skip ad (${seconds})`;
  }, 1000);
}

async function renderOverview() {
  pageFrame('overview', `
    <div class="ad-slot" id="ad-slot"></div>
    <div class="dashboard-columns">
      <div class="column">
        <div class="metric-grid">
          <article class="metric"><div class="metric-top"><span>Wallet</span><i data-lucide="wallet"></i></div><strong id="metric-wallet">$0</strong><small>Available balance</small></article>
          <article class="metric"><div class="metric-top"><span>Active tasks</span><i data-lucide="list-checks"></i></div><strong id="metric-tasks">0</strong><small>Opportunities on TaskFlow</small></article>
          <article class="metric"><div class="metric-top"><span>Gigs</span><i data-lucide="briefcase-business"></i></div><strong id="metric-gigs">0</strong><small>Services available</small></article>
        </div>
        <section class="panel"><div class="panel-head"><div><h2>Messages & offers</h2><p class="panel-subtitle">Conversations and offers from other members.</p></div><button class="button" type="button" data-refresh-overview><i data-lucide="refresh-cw"></i>Refresh</button></div><div id="overview-messages">${emptyState('No conversations or offers yet.')}</div></section>
        <section class="panel"><div class="panel-head"><h2>Profile & trust</h2><span class="badge" id="overview-tier">Standard</span></div><div class="rows"><div class="data-row"><strong>Wallet security</strong><span>Enabled</span></div><div class="data-row"><strong>Marketplace fees</strong><span>1% + 5% commission</span></div><div class="data-row"><strong>Escrow verification</strong><span>Manual review</span></div></div></section>
      </div>
      <div class="column">
        <section class="panel"><div class="panel-head"><div><h2>Publish task</h2></div><span class="badge">Simple</span></div><form id="quick-task-form"><div class="field"><label for="quick-title">Task title</label><input id="quick-title" required minlength="3" maxlength="160" placeholder="Task title"></div><div class="field"><label for="quick-description">Task description</label><textarea id="quick-description" required placeholder="Task description"></textarea></div><div class="field"><label for="quick-category">Category</label><select id="quick-category" required><option value="">Loading categories...</option></select></div><details class="task-details"><summary>Video and payout details</summary><div class="field"><label for="quick-video">Video URL</label><input id="quick-video" type="url" required placeholder="https://example.com/video"></div><div class="field"><label for="quick-budget">Budget (USD)</label><input id="quick-budget" type="number" min="1" step="0.01" value="10" required></div></details><button class="button button-primary" type="submit">Publish task</button></form></section>
        <section class="panel"><div class="panel-head"><h2>Recent notifications</h2><a href="/vendor" class="button-quiet" data-route="vendor">View all</a></div><div class="feed" id="overview-notifications">${emptyState('No recent notifications.')}</div></section>
      </div>
    </div>`);
  const [summary, wallet, tasks, gigs, notifications, offers, ads] = await Promise.all([
    api('/api/summary').catch(() => ({})), api('/api/wallet').catch(() => ({ balanceCents: 0 })),
    api('/api/tasks').catch(() => ({ tasks: [] })),
    api('/api/gigs').catch(() => ({ gigs: [] })), api('/api/notifications').catch(() => ({ notifications: [] })),
    api('/api/content-offers').catch(() => ({ offers: [] })), api('/api/ads').catch(() => ({ ads: [] }))
  ]);
  const balance = Number(wallet.balanceCents || 0);
  $('#metric-wallet').textContent = money(balance);
  $('#metric-tasks').textContent = String(tasks.tasks?.length ?? summary.activeTasks ?? 0);
  $('#metric-gigs').textContent = String(gigs.gigs?.length ?? 0);
  $('#overview-notifications').innerHTML = notificationMarkup(notifications.notifications || []);
  $('#overview-tier').textContent = (currentUser?.subscriptionTier || 'standard').replace(/^./, (letter) => letter.toUpperCase());
  $('#overview-messages').innerHTML = offers.offers?.length ? offers.offers.slice(0, 5).map((offer) => `<div class="data-row"><div><strong>${escapeHtml(offer.content_type)} offer</strong><small>${escapeHtml(offer.status)}</small></div><span>${money(offer.amount_cents)}</span></div>`).join('') : emptyState('No conversations or offers yet.');
  const topAd = (ads.ads || []).find((ad) => ['homepage-top', 'featured'].includes(ad.placement)) || (ads.ads || [])[0];
  showAd(topAd);
  const categories = await loadCategories();
  $('#quick-category').innerHTML = categoryOptions(categories);
}

async function renderTasks() {
  const categories = await loadCategories();
  pageFrame('tasks', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Publish a task</h2><p class="panel-subtitle">Describe the work, budget, and proof needed to complete it.</p></div><span class="badge">New task</span></div><form id="task-form"><div class="field"><label for="task-title">Task title</label><input id="task-title" required minlength="3" maxlength="160" placeholder="Create a product demo video"></div><div class="form-grid"><div class="field"><label for="task-video">Video URL</label><input id="task-video" type="url" required placeholder="https://example.com/video"></div><div class="field"><label for="task-budget">Amount (USD)</label><input id="task-budget" type="number" min="1" step="0.01" value="50" required></div></div><div class="field"><label for="task-category">Category</label><select id="task-category" required>${categoryOptions(categories)}</select></div><div class="field"><label for="task-description">Description</label><textarea id="task-description" rows="4" required placeholder="Describe the task and success criteria."></textarea></div><div class="field"><label for="task-instructions">Proof requirements</label><textarea id="task-instructions" rows="3" placeholder="What evidence should the worker submit?"></textarea></div><button class="button button-primary" type="submit">Publish task</button></form></section><section class="panel"><div class="panel-head"><div><h2>Task overview</h2><p class="panel-subtitle">Active tasks and their budgets.</p></div><span class="badge" id="task-count">0 tasks</span></div><div id="task-table">${emptyState('Loading tasks...')}</div></section></div>`);
  const response = await api('/api/tasks').catch(() => ({ tasks: [] }));
  const tasks = response.tasks || [];
  $('#task-count').textContent = `${tasks.length} tasks`;
  $('#task-table').innerHTML = tasks.length ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Budget</th><th>Status</th><th>Action</th></tr></thead><tbody>${tasks.map((task) => `<tr><td><strong>${escapeHtml(task.title)}</strong><br><small>${escapeHtml(task.category || 'General')}</small></td><td>${money(task.payoutCents)}</td><td><span class="badge">${escapeHtml(task.status || 'Active')}</span></td><td><button type="button" class="button" data-contact="task" data-id="${escapeHtml(task.id)}" data-title="${escapeHtml(task.title)}">Contact</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('No tasks have been published yet.');
}

function mediaMarkup(item) {
  const entry = Array.isArray(item.media) ? item.media[0] : null;
  const url = typeof entry === 'string' ? entry : entry?.url;
  if (!url) return '<div class="listing-placeholder"><i data-lucide="image"></i></div>';
  const safeUrl = escapeHtml(url);
  return typeof entry === 'object' && /^video\//i.test(entry.mimeType || '') ? `<video src="${safeUrl}" controls preload="metadata"></video>` : `<img src="${safeUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`;
}

function renderMarketplaceCards(items) {
  const container = $('#marketplace-cards');
  if (!container) return;
  const search = String($('#market-search')?.value || new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
  const category = $('#market-category')?.value || '';
  const filtered = items.filter((item) => `${item.title || ''} ${item.type || ''} ${item.category || ''}`.toLowerCase().includes(search) && (!category || item.category === category));
  container.innerHTML = filtered.length ? filtered.map((item) => `<article class="listing-card">${mediaMarkup(item)}<div class="listing-body"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.category || item.type || 'Marketplace listing')}</p><div class="listing-meta"><span class="badge">${escapeHtml(item.type || 'Listing')}</span><strong>${money(item.priceCents)}</strong></div><button type="button" class="button" data-contact="listing" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}">Contact seller</button></div></article>`).join('') : emptyState('No listings match these filters.');
  window.lucide?.createIcons();
}

async function renderMarketplace() {
  const categories = await loadCategories();
  pageFrame('marketplace', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Create a listing</h2><p class="panel-subtitle">Add a marketplace item with a clear price and image.</p></div><span class="badge">Buy & sell</span></div><form id="listing-form"><div class="field"><label for="listing-title">Listing title</label><input id="listing-title" required minlength="3" maxlength="160" placeholder="Camera, service, or digital item"></div><div class="form-grid"><div class="field"><label for="listing-type">Type</label><select id="listing-type"><option value="physical">Physical</option><option value="digital">Digital</option><option value="service">Service</option><option value="software">Software</option></select></div><div class="field"><label for="listing-price">Price (USD)</label><input id="listing-price" type="number" min="0.01" step="0.01" value="50" required></div></div><div class="field"><label for="listing-category">Category</label><select id="listing-category" required>${categoryOptions(categories)}</select></div><div class="field"><label for="listing-media">Photos or video</label><input id="listing-media" type="file" accept="image/*,video/*" multiple required></div><button class="button button-primary" type="submit">Publish listing</button></form></section><section class="panel"><div class="panel-head"><div><h2>Marketplace</h2><p class="panel-subtitle">Browse active listings and contact their owners.</p></div><span class="badge" id="market-count">0 listings</span></div><div class="form-grid"><div class="field"><label for="market-search">Search listings</label><input id="market-search" type="search" class="filter-input" placeholder="Search by title or type"></div><div class="field"><label for="market-category">Category</label><select id="market-category" class="filter-input">${categoryOptions(categories, true)}</select></div></div><div class="cards-grid" id="marketplace-cards"></div></section></div>`);
  marketplaceItems = (await api('/api/listings').catch(() => ({ listings: [] }))).listings || [];
  $('#market-count').textContent = `${marketplaceItems.length} listings`;
  $('#market-search').value = new URLSearchParams(location.search).get('q') || '';
  renderMarketplaceCards(marketplaceItems);
}

async function renderProducts() {
  const categories = await loadCategories();
  pageFrame('products', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Sell a product</h2><p class="panel-subtitle">Add product details, price, inventory, and media.</p></div></div><form id="product-form"><div class="field"><label for="product-title">Product title</label><input id="product-title" required minlength="3" maxlength="120"></div><div class="field"><label for="product-category">Category</label><select id="product-category" required>${categoryOptions(categories)}</select></div><div class="form-grid"><div class="field"><label for="product-price">Price (USD)</label><input id="product-price" type="number" min="0.01" step="0.01" value="25" required></div><div class="field"><label for="product-stock">Stock</label><input id="product-stock" type="number" min="0" value="10" required></div></div><div class="field"><label for="product-description">Description</label><textarea id="product-description" required></textarea></div><div class="field"><label for="product-media">Product images</label><input id="product-media" type="file" accept="image/*" multiple></div><button class="button button-primary" type="submit">List product</button></form></section><section class="panel"><div class="panel-head"><h2>Products</h2><span class="badge" id="product-count">0 products</span></div><div class="cards-grid" id="product-cards">${emptyState('Loading products...')}</div></section></div>`);
  const products = (await api('/api/products').catch(() => ({ products: [] }))).products || [];
  $('#product-count').textContent = `${products.length} products`;
  $('#product-cards').innerHTML = products.length ? products.map((product) => `<article class="listing-card">${mediaMarkup({ ...product, media: product.media || [] })}<div class="listing-body"><h3>${escapeHtml(product.title)}</h3><p>${escapeHtml(product.category || 'Product')} · ${Number(product.stock || 0)} in stock</p><div class="listing-meta"><strong>${money(product.price_cents || product.priceCents)}</strong></div><button class="button" type="button" data-contact="product" data-id="${escapeHtml(product.id)}" data-title="${escapeHtml(product.title)}">Contact seller</button></div></article>`).join('') : emptyState('No products are listed yet.');
}

async function renderGigs() {
  const categories = await loadCategories();
  pageFrame('gigs', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Create a gig</h2><p class="panel-subtitle">Offer a service with clear delivery expectations.</p></div></div><form id="gig-form"><div class="field"><label for="gig-title">Gig title</label><input id="gig-title" required minlength="3" maxlength="120" placeholder="Short-form video editing"></div><div class="field"><label for="gig-category">Category</label><select id="gig-category" required>${categoryOptions(categories)}</select></div><div class="form-grid"><div class="field"><label for="gig-price">Price (USD)</label><input id="gig-price" type="number" min="0.01" step="0.01" value="120" required></div><div class="field"><label for="gig-days">Delivery (days)</label><input id="gig-days" type="number" min="1" max="30" value="3" required></div></div><div class="field"><label for="gig-description">Description</label><textarea id="gig-description" required minlength="10"></textarea></div><button class="button button-primary" type="submit">Publish gig</button></form></section><section class="panel"><div class="panel-head"><h2>Available gigs</h2><span class="badge" id="gig-count">0 gigs</span></div><div class="cards-grid" id="gig-cards">${emptyState('Loading gigs...')}</div></section></div>`);
  const gigs = (await api('/api/gigs').catch(() => ({ gigs: [] }))).gigs || [];
  $('#gig-count').textContent = `${gigs.length} gigs`;
  $('#gig-cards').innerHTML = gigs.length ? gigs.map((gig) => `<article class="listing-card"><div class="listing-body"><h3>${escapeHtml(gig.title)}</h3><p>${escapeHtml(gig.description || '')}</p><div class="listing-meta"><span class="badge">${escapeHtml(gig.category || 'Service')}</span><strong>${money(gig.price_cents || gig.priceCents)}</strong></div><span class="badge">${Number(gig.delivery_days || gig.deliveryDays || 3)} day delivery</span></div></article>`).join('') : emptyState('No gigs are available yet.');
}

async function renderVendor() {
  pageFrame('vendor', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Store identity</h2><p class="panel-subtitle">Submit your shop details for review.</p></div><span class="badge" id="store-status">No request</span></div><form id="store-form"><div class="field"><label for="store-name">Business name</label><input id="store-name" required maxlength="120"></div><div class="field"><label for="store-description">Store description</label><textarea id="store-description" required minlength="10" maxlength="1500"></textarea></div><div class="field"><label for="store-logo">Store logo</label><input id="store-logo" type="file" accept="image/*"></div><button class="button button-primary" type="submit">Submit for review</button></form></section><div class="column"><section class="panel"><div class="panel-head"><h2>Inventory</h2><a class="button-quiet" href="/products" data-route="products">Add product</a></div><div id="vendor-inventory">${emptyState('Loading inventory...')}</div></section><section class="panel"><div class="panel-head"><h2>Incoming orders</h2></div><div id="vendor-orders">${emptyState('Loading orders...')}</div></section><section class="panel"><div class="panel-head"><h2>Alerts and messages</h2></div><div class="feed" id="vendor-notifications">${emptyState('Loading notifications...')}</div></section></div></div>`);
  const results = await Promise.all([api('/api/store/me').catch(() => ({ store: null })), api('/api/vendor/inventory').catch(() => ({ products: [] })), api('/api/vendor/orders').catch(() => ({ orders: [] })), api('/api/notifications').catch(() => ({ notifications: [] }))]);
  const [store, inventory, orders, notifications] = results;
  if (store.store) { $('#store-name').value = store.store.businessName || ''; $('#store-description').value = store.store.description || ''; $('#store-status').textContent = store.store.status || 'Pending'; }
  $('#vendor-inventory').innerHTML = inventory.products?.length ? inventory.products.map((product) => `<div class="data-row"><div><strong>${escapeHtml(product.title)}</strong><small>${escapeHtml(product.category || 'Product')} · ${Number(product.stock)} in stock</small></div><span>${money(product.priceCents)}</span></div>`).join('') : emptyState('No products in your inventory.');
  $('#vendor-orders').innerHTML = orders.orders?.length ? orders.orders.map((order) => `<div class="data-row"><div><strong>${escapeHtml(order.productTitle)}</strong><small>${escapeHtml(order.status)}</small></div><span>${money(order.amountCents)}</span></div>`).join('') : emptyState('No incoming orders.');
  $('#vendor-notifications').innerHTML = notificationMarkup(notifications.notifications || []);
}

async function renderWallet() {
  pageFrame('wallet', `<div class="stack"><section class="panel"><div class="panel-head"><div><h2>Wallet balance</h2><p class="panel-subtitle">Balances reflect verified platform transactions.</p></div><span class="badge">Secure</span></div><strong id="wallet-balance" style="font-size:32px;color:#0f172a">$0.00</strong></section><section class="panel"><div class="panel-head"><h2>Billing history</h2></div><div id="wallet-history">${emptyState('Loading transactions...')}</div></section><section class="panel"><div class="panel-head"><h2>Payment methods</h2><span class="badge">Stripe verification</span></div><p class="panel-subtitle">Add or verify a payment method from your account billing settings.</p><a class="button" href="/settings" data-route="settings">Open billing settings</a></section></div>`);
  const wallet = await api('/api/wallet').catch(() => ({ balanceCents: 0, transactions: [] }));
  $('#wallet-balance').textContent = money(wallet.balanceCents);
  $('#wallet-history').innerHTML = wallet.transactions?.length ? wallet.transactions.slice(0, 30).map((transaction) => `<div class="data-row"><div><strong>${escapeHtml(transaction.kind || 'Transaction')}</strong><small>${escapeHtml(transaction.status || 'Recorded')} · ${new Date(transaction.created_at || transaction.createdAt || Date.now()).toLocaleDateString()}</small></div><span>${money(transaction.amount_cents || transaction.amountCents)}</span></div>`).join('') : emptyState('No wallet activity yet.');
}

async function renderProfile() {
  pageFrame('profile', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Profile settings</h2><p class="panel-subtitle">Manage the details shown to clients and buyers.</p></div></div><form id="profile-form"><div class="field"><label for="profile-name">Display name</label><input id="profile-name" required maxlength="100"></div><div class="form-grid"><div class="field"><label for="profile-phone">Phone</label><input id="profile-phone" type="tel" placeholder="+1 555 0100"></div><div class="field"><label for="profile-country">Country</label><select id="profile-country"><option value="US">United States</option><option value="PK">Pakistan</option><option value="IN">India</option><option value="AE">United Arab Emirates</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="SA">Saudi Arabia</option><option value="BD">Bangladesh</option><option value="NG">Nigeria</option></select></div></div><div class="field"><label for="profile-bio">Bio</label><textarea id="profile-bio" rows="5" maxlength="500"></textarea></div><button class="button button-primary" type="submit">Save profile</button></form></section><section class="panel"><div class="panel-head"><h2>Account preview</h2><span class="badge">Active</span></div><div class="sidebar-user"><span class="avatar" data-user-initials>TF</span><span class="sidebar-user-copy"><strong data-user-name>Husnain</strong><small data-user-email>Account</small></span></div><div class="rows" style="margin-top:16px"><div class="data-row"><strong>Trust score</strong><span id="profile-trust">Not rated</span></div><div class="data-row"><strong>Account tier</strong><span id="profile-tier">Standard</span></div><div class="data-row"><strong>Member since</strong><span id="profile-joined">Active member</span></div></div></section></div>`);
  const data = await api('/api/profile').catch(() => ({ user: currentUser }));
  const user = data.user || currentUser || {};
  $('#profile-name').value = user.name || '';
  $('#profile-phone').value = user.phone || '';
  $('#profile-country').value = user.country || 'US';
  $('#profile-bio').value = user.profile?.bio || user.bio || '';
  $('#profile-trust').textContent = user.trust_score == null && user.trustScore == null ? 'Not rated' : `${user.trust_score ?? user.trustScore}%`;
  $('#profile-tier').textContent = user.subscriptionTier || 'Standard';
  $('#profile-joined').textContent = user.created_at ? new Date(user.created_at).toLocaleDateString() : 'Active member';
}

async function renderSupport() {
  pageFrame('support', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Contact support</h2><p class="panel-subtitle">Send a private request to the TaskFlow support team.</p></div></div><form id="support-form"><div class="field"><label for="support-subject">Subject</label><input id="support-subject" required minlength="3" maxlength="120" placeholder="What can we help with?"></div><div class="field"><label for="support-message">Message</label><textarea id="support-message" required rows="6" maxlength="2000"></textarea></div><button class="button button-primary" type="submit">Send to support</button></form></section><section class="panel"><div class="panel-head"><h2>Your conversations</h2></div><div id="support-threads">${emptyState('Loading conversations...')}</div></section></div>`);
  const threads = (await api('/api/support/threads').catch(() => ({ threads: [] }))).threads || [];
  $('#support-threads').innerHTML = threads.length ? threads.map((thread) => `<div class="data-row"><div><strong>${escapeHtml(thread.subject)}</strong><small>${escapeHtml(thread.lastMessage || 'No replies yet')}</small></div><span class="badge">${escapeHtml(thread.status)}</span></div>`).join('') : emptyState('No support conversations yet.');
}

async function renderSettings() {
  pageFrame('settings', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><h2>Account preferences</h2><span class="badge">Personal</span></div><div class="rows"><div class="data-row"><strong>Email address</strong><span>${escapeHtml(currentUser?.email || 'Not set')}</span></div><div class="data-row"><strong>Account role</strong><span>${escapeHtml(currentUser?.role || 'Member')}</span></div><div class="data-row"><strong>Account tier</strong><span>${escapeHtml(currentUser?.subscriptionTier || 'Standard')}</span></div></div><a class="button" href="/profile" data-route="profile">Edit profile</a></section><section class="panel"><div class="panel-head"><h2>Security</h2><span class="badge">Protected</span></div><div class="rows"><div class="data-row"><strong>Wallet security</strong><span>Enabled</span></div><div class="data-row"><strong>Payment verification</strong><span>Cloudflare + email OTP</span></div><div class="data-row"><strong>Session status</strong><span>Active</span></div></div><a class="button" href="/wallet" data-route="wallet">Wallet settings</a></section></div>`);
}

async function renderPremium() {
  pageFrame('premium', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><h2>Premium membership</h2><span class="badge">Account boost</span></div><p class="panel-subtitle">Priority visibility, a verified profile badge, and member benefits.</p><div class="trust-grid"><div class="trust-stat"><span>Visibility</span><strong>Priority placement</strong></div><div class="trust-stat"><span>Profile</span><strong>Premium badge</strong></div><div class="trust-stat"><span>Marketplace</span><strong>Member discounts</strong></div><div class="trust-stat"><span>Referrals</span><strong>10 verified</strong></div></div></section><section class="panel"><div class="panel-head"><h2>Activate Premium</h2><span class="badge" id="premium-state">Standard</span></div><p class="panel-subtitle">Upgrade through a verified checkout or referral qualification.</p><div class="form-actions"><button class="button button-primary" id="premium-pay" type="button">Upgrade to Premium</button><button class="button" id="premium-referrals" type="button">View referrals</button></div><p class="panel-subtitle" id="premium-note"></p></section></div>`);
  $('#premium-state').textContent = currentUser?.subscriptionTier || 'Standard';
}

function adminTable(title, rows, emptyMessage = 'Nothing to review.') {
  return `<section class="panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span class="badge">${rows.length} records</span></div><div class="table-wrap"><table><thead><tr><th>Record</th><th>Owner / details</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td><strong>${escapeHtml(row.title || row.name || row.businessName || row.subject || row.kind || row.id)}</strong><br><small>${escapeHtml(row.id || '')}</small></td><td>${escapeHtml(row.owner_name || row.ownerEmail || row.email || row.description || row.body || row.category || '')}</td><td><span class="badge">${escapeHtml(row.status || row.accountStatus || 'active')}</span></td><td>${row.action || '<span class="badge">View</span>'}</td></tr>`).join('') : `<tr><td colspan="4">${escapeHtml(emptyMessage)}</td></tr>`}</tbody></table></div></section>`;
}

async function renderAdmin() {
  if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
    navigate('overview');
    notify('Admin access is required.');
    return;
  }
  pageFrame('admin', `<div class="metric-grid" id="admin-metrics">${['Users', 'Products', 'Listings', 'Gigs'].map((label) => `<article class="metric"><div class="metric-top"><span>${label}</span><i data-lucide="bar-chart-3"></i></div><strong>...</strong><small>Loading owner data</small></article>`).join('')}</div><div class="stack" id="admin-content"><section class="panel"><p class="empty">Loading complete platform control center...</p></section></div>`,'Owner control center');
  const [overview, content, users, stores, support, reports, categories, ads] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/content'), api('/api/admin/users'), api('/api/admin/store-requests'), api('/api/admin/support/threads'), api('/api/admin/reports'), api('/api/admin/categories'), api('/api/ads')
  ]);
  const stats = overview.stats || {};
  const metrics = [stats.activeUsers || 0, stats.activeProducts || 0, content.listings?.length || 0, stats.activeGigs || 0];
  document.querySelectorAll('#admin-metrics .metric strong').forEach((element, index) => { element.textContent = String(metrics[index]); });
  const action = (type, id, label = 'Delete') => `<button class="button" type="button" data-admin-delete="${type}" data-id="${escapeHtml(id)}">${label}</button>`;
  const userRows = (users.users || []).map((user) => ({ ...user, action: user.role === 'admin' ? '<span class="badge">Protected owner</span>' : action('users', user.id, 'Remove') }));
  const taskRows = (content.tasks || []).map((task) => ({ ...task, action: action('tasks', task.id) }));
  const productRows = (content.products || []).map((product) => ({ ...product, action: action('products', product.id) }));
  const listingRows = (content.listings || []).map((listing) => ({ ...listing, action: action('listings', listing.id) }));
  const gigRows = (content.gigs || []).map((gig) => ({ ...gig, action: action('gigs', gig.id) }));
  const storeRows = (stores.requests || []).map((store) => ({ ...store, action: store.status === 'pending' ? `<button class="button" type="button" data-store-review="${escapeHtml(store.id)}" data-decision="verified">Verify</button> <button class="button" type="button" data-store-review="${escapeHtml(store.id)}" data-decision="rejected">Changes</button>` : '<span class="badge">Reviewed</span>' }));
  const adRows = (ads.ads || []).map((ad) => ({ ...ad, action: action('ads', ad.id) }));
  $('#admin-content').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>Create third-party ad</h2><p class="panel-subtitle">Upload a banner or video and choose where it appears.</p></div><span class="badge">Admin only</span></div><form id="admin-ad-form" class="form-grid"><div class="field"><label for="admin-ad-title">Campaign title</label><input id="admin-ad-title" required minlength="3" maxlength="120"></div><div class="field"><label for="admin-ad-category">Category</label><input id="admin-ad-category" required maxlength="60" placeholder="Technology"></div><div class="field"><label for="admin-ad-placement">Placement</label><select id="admin-ad-placement" required><option value="homepage-top">Homepage top</option><option value="sidebar">Sidebar</option><option value="featured">Featured</option></select></div><div class="field"><label for="admin-ad-duration">Campaign duration (days)</label><input id="admin-ad-duration" type="number" min="1" max="365" value="7" required></div><div class="field field-full"><label for="admin-ad-description">Description</label><textarea id="admin-ad-description" required minlength="5"></textarea></div><div class="field"><label for="admin-ad-media">Picture or video</label><input id="admin-ad-media" type="file" accept="image/*,video/*" required></div><div class="field"><label for="admin-ad-skip">Skip ad</label><select id="admin-ad-skip"><option value="true">Allow skip after 3 seconds</option><option value="false">Do not allow skip</option></select></div><div class="field-full"><button class="button button-primary" type="submit">Publish ad</button></div></form></section>${adminTable('Users', userRows, 'No registered users.')}${adminTable('Tasks', taskRows)}${adminTable('Products', productRows)}${adminTable('Marketplace listings', listingRows)}${adminTable('Gigs', gigRows)}${adminTable('Third-party ads', adRows)}${adminTable('Store requests', storeRows)}${adminTable('Support inbox', support.threads || [])}${adminTable('Reports', reports.reports || [])}${adminTable('Categories', categories.categories || [])}<section class="panel"><div class="panel-head"><div><h2>Platform totals</h2><p class="panel-subtitle">Owner-only operational visibility.</p></div><span class="badge">Protected API</span></div><div class="rows"><div class="data-row"><strong>Open disputes</strong><span>${Number(stats.openDisputes || 0)}</span></div><div class="data-row"><strong>Open reports</strong><span>${Number(stats.openReports || 0)}</span></div><div class="data-row"><strong>Active ads</strong><span>${Number(stats.activeAds || 0)}</span></div><div class="data-row"><strong>Categories</strong><span>${Number(stats.categories || 0)}</span></div></div></section>`;
}

async function renderRoute(route) {
  const renderers = { overview: renderOverview, tasks: renderTasks, marketplace: renderMarketplace, products: renderProducts, vendor: renderVendor, gigs: renderGigs, wallet: renderWallet, profile: renderProfile, support: renderSupport, settings: renderSettings, premium: renderPremium, admin: renderAdmin };
  const normalized = renderers[route] ? route : 'overview';
  await renderers[normalized]();
  document.querySelectorAll('a[data-route]').forEach((link) => {
    if (link.dataset.route === normalized && link.classList.contains('nav-link')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  window.lucide?.createIcons();
}

function navigate(route) {
  if (!routePaths[route]) return;
  if (location.pathname !== routePaths[route]) history.pushState({}, '', routePaths[route]);
  window.scrollTo(0, 0);
  renderRoute(route).catch((error) => notify(error.message));
}

async function uploadFiles(files) {
  if (!files?.length) return [];
  const form = new FormData();
  Array.from(files).forEach((file) => form.append('files', file));
  const result = await api('/api/uploads', { method: 'POST', body: form });
  return result.files || [];
}

async function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const value = (id) => $(`#${id}`, form)?.value?.trim() || '';
  try {
    if (form.id === 'task-form' || form.id === 'quick-task-form') {
      const quick = form.id === 'quick-task-form';
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: value(quick ? 'quick-title' : 'task-title'), videoUrl: value(quick ? 'quick-video' : 'task-video'), category: value(quick ? 'quick-category' : 'task-category'), description: value(quick ? 'quick-description' : 'task-description'), instructions: value('task-instructions'), amountDollars: Number(value(quick ? 'quick-budget' : 'task-budget')), seconds: 60 }) });
      notify('Task published successfully.');
    } else if (form.id === 'listing-form') {
      const files = await uploadFiles($('#listing-media', form).files);
      await api('/api/listings', { method: 'POST', body: JSON.stringify({ title: value('listing-title'), type: value('listing-type'), category: value('listing-category'), priceCents: Math.round(Number(value('listing-price')) * 100), media: files.map((file) => ({ url: file.url, mimeType: file.mimeType })) }) });
      notify('Marketplace listing published.');
    } else if (form.id === 'product-form') {
      const files = await uploadFiles($('#product-media', form).files);
      await api('/api/products', { method: 'POST', body: JSON.stringify({ title: value('product-title'), category: value('product-category'), description: value('product-description'), priceDollars: Number(value('product-price')), stock: Number(value('product-stock')), media: files.map((file) => file.url) }) });
      notify('Product listed successfully.');
    } else if (form.id === 'gig-form') {
      await api('/api/gigs', { method: 'POST', body: JSON.stringify({ title: value('gig-title'), category: value('gig-category'), description: value('gig-description'), priceDollars: Number(value('gig-price')), deliveryDays: Number(value('gig-days')) }) });
      notify('Gig published successfully.');
    } else if (form.id === 'profile-form') {
      await api('/api/profile', { method: 'PUT', body: JSON.stringify({ name: value('profile-name'), phone: value('profile-phone'), country: value('profile-country'), bio: value('profile-bio') }) });
      currentUser = { ...currentUser, name: value('profile-name'), phone: value('profile-phone'), country: value('profile-country') };
      setShellUser(currentUser);
      notify('Profile saved successfully.');
    } else if (form.id === 'support-form') {
      await api('/api/support/threads', { method: 'POST', body: JSON.stringify({ subject: value('support-subject'), body: value('support-message') }) });
      notify('Your message was sent to support.');
    } else if (form.id === 'store-form') {
      let logoUrl;
      const [logo] = $('#store-logo', form).files || [];
      if (logo) logoUrl = (await uploadFiles([logo]))[0]?.url;
      await api('/api/store/me', { method: 'PUT', body: JSON.stringify({ businessName: value('store-name'), description: value('store-description'), logoUrl }) });
      notify('Store submitted for review.');
    } else if (form.id === 'admin-ad-form') {
      const [mediaFile] = $('#admin-ad-media', form).files || [];
      const uploaded = await uploadFiles(mediaFile ? [mediaFile] : []);
      if (!uploaded[0]?.url) throw new Error('Choose an image or video for the advertisement.');
      await api('/api/ads', { method: 'POST', body: JSON.stringify({ title: value('admin-ad-title'), description: value('admin-ad-description'), category: value('admin-ad-category'), location: value('admin-ad-placement'), priceCents: 1, placement: value('admin-ad-placement'), durationDays: Number(value('admin-ad-duration')), skipAllowed: value('admin-ad-skip') === 'true', media: [uploaded[0].url] }) });
      notify('Third-party ad published.');
    }
    form.reset();
    await renderRoute(location.pathname.slice(1));
  } catch (error) {
    notify(error.message);
  }
}

document.addEventListener('click', async (event) => {
  const routeLink = event.target.closest('a[data-route]');
  if (routeLink) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(routeLink.dataset.route);
    return;
  }
  if (event.target.closest('#sign-out')) {
    try { await api('/api/auth/logout', { method: 'POST' }); location.assign('/'); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('[data-refresh-overview]')) { await renderOverview(); return; }
  const contactButton = event.target.closest('[data-contact]');
  if (contactButton) {
    const amount = Number(window.prompt('Offer amount in USD', '10'));
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
      await api('/api/content-offers', { method: 'POST', body: JSON.stringify({ contentType: contactButton.dataset.contact, contentId: contactButton.dataset.id, amountCents: Math.round(amount * 100), message: '' }) });
      notify('Your offer was sent.');
    } catch (error) { notify(error.message); }
    return;
  }
  const deleteButton = event.target.closest('[data-admin-delete]');
  if (deleteButton) {
    if (!window.confirm('Remove this record from the platform?')) return;
    try {
      await api(`/api/admin/${encodeURIComponent(deleteButton.dataset.adminDelete)}/${encodeURIComponent(deleteButton.dataset.id)}`, { method: 'DELETE' });
      notify('Record removed by administrator.');
      await renderAdmin();
    } catch (error) { notify(error.message); }
    return;
  }
  const storeReview = event.target.closest('[data-store-review]');
  if (storeReview) {
    const note = storeReview.dataset.decision === 'rejected' ? window.prompt('What should the vendor change?', 'Please update your store details and resubmit.') : '';
    if (storeReview.dataset.decision === 'rejected' && note === null) return;
    try {
      await api(`/api/admin/store-requests/${encodeURIComponent(storeReview.dataset.storeReview)}/review`, { method: 'POST', body: JSON.stringify({ decision: storeReview.dataset.decision, note: note || undefined }) });
      notify('Store review updated.');
      await renderAdmin();
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('#premium-pay')) {
    try { const result = await api('/api/premium/checkout', { method: 'POST' }); if (result.checkoutUrl) location.assign(result.checkoutUrl); else notify('Premium checkout is not available right now.'); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('#premium-referrals')) {
    try { const result = await api('/api/referrals'); $('#premium-note').textContent = `${result.referralCount || 0} verified referrals. Share your link: ${result.referralUrl}`; }
    catch (error) { notify(error.message); }
  }
});

document.addEventListener('invalid', (event) => {
  const details = event.target.closest('details.task-details');
  if (details) details.open = true;
}, true);
document.addEventListener('submit', onSubmit);
document.addEventListener('input', (event) => { if (event.target.id === 'market-search') renderMarketplaceCards(marketplaceItems); });
document.addEventListener('change', (event) => { if (event.target.id === 'market-category') renderMarketplaceCards(marketplaceItems); });
document.addEventListener('keydown', async (event) => {
  if (event.target.id !== 'global-search' || event.key !== 'Enter') return;
  event.preventDefault();
  const query = event.target.value.trim();
  if (query) {
    history.pushState({}, '', `/marketplace?q=${encodeURIComponent(query)}`);
    await renderRoute('marketplace');
  } else navigate('marketplace');
});
window.addEventListener('popstate', () => renderRoute(location.pathname.slice(1)).catch((error) => notify(error.message)));

async function initialize() {
  try {
    const result = await api('/api/me');
    if (!result.user) { location.replace('/'); return; }
    const profile = await api('/api/profile').catch(() => ({ user: result.user }));
    setShellUser({ ...result.user, ...(profile.user || {}), subscriptionTier: result.user.subscriptionTier || profile.user?.subscriptionTier || 'standard' });
    let route = location.pathname.slice(1) || 'overview';
    if (route === 'dashboard') route = 'overview';
    if (!routePaths[route]) route = 'overview';
    if (location.pathname !== routePaths[route]) history.replaceState({}, '', routePaths[route]);
    await renderRoute(route);
  } catch {
    location.replace('/');
  }
}

initialize();
