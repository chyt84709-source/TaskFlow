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
let vendorStoreProducts = new Map();
let selectedSupportThreadId = null;
let supportMode = null;
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
  document.querySelectorAll('[data-user-initials]').forEach((element) => {
    const avatarUrl = user?.avatar_url || user?.avatarUrl || '';
    element.replaceChildren();
    if (avatarUrl) {
      const image = document.createElement('img');
      image.className = 'avatar-photo';
      image.src = avatarUrl;
      image.alt = '';
      element.append(image);
    } else element.textContent = initials(user?.name || 'Husnain');
  });
  const isPremium = (user?.subscriptionTier || user?.subscription_tier) === 'premium';
  $('[data-tier]').textContent = isPremium ? 'PREMIUM' : 'STANDARD';
  $('[data-tier]').classList.toggle('premium', true);
  $('[data-verified]').classList.toggle('hidden', !isPremium || (!user?.greenTick && !user?.green_tick));
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

function storePlanBadge(tier, greenTick) {
  const premium = tier === 'premium';
  const badge = document.createElement('span');
  badge.className = 'badge store-plan-badge';
  badge.textContent = premium ? 'Premium store' : 'Standard store';
  if (premium && greenTick) {
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'badge-check');
    badge.prepend(icon);
  }
  return badge;
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
  const isVideo = /^video\//i.test(typeof media === 'object' ? media.mimeType || '' : '');
  const mediaMarkup = isVideo
    ? `<video id="ad-video" src="${safeUrl}" autoplay playsinline preload="auto"></video>`
    : `<img src="${safeUrl}" alt="${escapeHtml(ad.title || 'Sponsored content')}" loading="eager">`;
  slot.innerHTML = `${mediaMarkup}<div class="ad-slot-copy"><div><strong>${escapeHtml(ad.title || 'Sponsored')}</strong><small>Sponsored · ${escapeHtml(ad.category || 'Featured')}</small></div>${isVideo ? '<button class="button ad-skip" type="button" disabled>Skip ad (3)</button>' : ''}</div>`;
  slot.classList.add('is-visible');
  const skip = $('.ad-skip', slot);
  const video = $('#ad-video', slot);
  if (!skip) return;
  let seconds = 3;
  let timer;
  const startCountdown = () => {
    if (timer) return;
    skip.disabled = true;
    skip.textContent = 'Skip ad (3)';
    timer = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(timer);
        skip.disabled = false;
        skip.textContent = 'Skip ad';
        skip.addEventListener('click', () => {
          video.pause();
          video.currentTime = 0;
          skip.disabled = false;
          skip.textContent = 'Play ad again';
        }, { once: true });
      } else skip.textContent = `Skip ad (${seconds})`;
    }, 1000);
  };
  if (video) {
    video.addEventListener('ended', () => {
      if (timer) clearInterval(timer);
      skip.disabled = false;
      skip.textContent = 'Play ad again';
    });
    video.addEventListener('playing', startCountdown, { once: true });
    video.play().catch(() => {
      skip.disabled = false;
      skip.textContent = 'Play ad';
    });
    skip.addEventListener('click', () => {
      if (skip.textContent !== 'Play ad' && skip.textContent !== 'Play ad again') return;
      video.currentTime = 0;
      video.play().catch(() => {});
    });
  } else startCountdown();
}

async function renderOverview() {
  pageFrame('overview', `
    <div class="ad-slot" id="ad-slot"></div>
    <div class="metric-grid overview-metrics">
      <a class="metric" href="/marketplace" data-route="marketplace"><div class="metric-top"><span>Marketplace items</span><i data-lucide="store"></i></div><strong id="overview-listing-count">0</strong><small>Browse current listings</small></a>
      <a class="metric" href="/tasks" data-route="tasks"><div class="metric-top"><span>Active tasks</span><i data-lucide="list-checks"></i></div><strong id="overview-task-count">0</strong><small>Available opportunities</small></a>
      <a class="metric" href="/products" data-route="products"><div class="metric-top"><span>Products</span><i data-lucide="package"></i></div><strong id="overview-product-count">0</strong><small>Browse products</small></a>
      <a class="metric" href="/vendor" data-route="vendor"><div class="metric-top"><span>Your stores</span><i data-lucide="building-2"></i></div><strong id="overview-store-count">0</strong><small>Store and order activity</small></a>
    </div>
    <div class="dashboard-columns overview-content">
      <div class="column">
        <section class="panel"><div class="panel-head"><div><h2>Marketplace</h2><p class="panel-subtitle">Recently added listings.</p></div><a class="button-quiet" href="/marketplace" data-route="marketplace">View all</a></div><div class="cards-grid overview-cards" id="overview-marketplace">${emptyState('Loading marketplace items...')}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Products</h2><p class="panel-subtitle">New products from the community.</p></div><a class="button-quiet" href="/products" data-route="products">View all</a></div><div class="cards-grid overview-cards" id="overview-products">${emptyState('Loading products...')}</div></section>
      </div>
      <div class="column">
        <section class="panel"><div class="panel-head"><div><h2>Active tasks</h2><p class="panel-subtitle">Tasks currently open on TaskFlow.</p></div><a class="button-quiet" href="/tasks" data-route="tasks">View all</a></div><div class="rows" id="overview-tasks">${emptyState('Loading tasks...')}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Vendor store activity</h2><p class="panel-subtitle">Your store reviews and recent incoming orders.</p></div><a class="button-quiet" href="/vendor" data-route="vendor">Open stores</a></div><div class="rows" id="overview-vendor-activity">${emptyState('Loading store activity...')}</div></section>
      </div>
    </div>`);
  const [listingsResponse, tasksResponse, productsResponse, storeResponse, ordersResponse, ads] = await Promise.all([
    api('/api/listings').catch(() => ({ listings: [] })),
    api('/api/tasks').catch(() => ({ tasks: [] })),
    api('/api/products').catch(() => ({ products: [] })),
    api('/api/store/me').catch(() => ({ stores: [] })),
    api('/api/vendor/orders').catch(() => ({ orders: [] })),
    api('/api/ads').catch(() => ({ ads: [] }))
  ]);
  const listings = listingsResponse.listings || [];
  const tasks = tasksResponse.tasks || [];
  const products = productsResponse.products || [];
  const stores = storeResponse.stores || (storeResponse.store ? [storeResponse.store] : []);
  const orders = ordersResponse.orders || [];
  $('#overview-listing-count').textContent = String(listings.length);
  $('#overview-task-count').textContent = String(tasks.length);
  $('#overview-product-count').textContent = String(products.length);
  $('#overview-store-count').textContent = String(stores.length);
  $('#overview-marketplace').innerHTML = listings.length ? listings.slice(0, 4).map((item) => `<article class="listing-card">${mediaMarkup(item)}<div class="listing-body"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.category || item.type || 'Marketplace listing')}</p><div class="listing-meta"><span class="badge">${escapeHtml(item.type || 'Listing')}</span><strong>${money(item.priceCents || item.price_cents)}</strong></div></div></article>`).join('') : emptyState('No marketplace listings yet.');
  $('#overview-products').innerHTML = products.length ? products.slice(0, 4).map((item) => `<article class="listing-card product-card">${mediaMarkup(item)}<div class="listing-body"><span class="badge">${escapeHtml(item.category || 'Product')}</span><h3>${escapeHtml(item.title)}</h3><div class="listing-meta"><span class="product-rating">${item.store_name ? escapeHtml(item.store_name) : 'New arrival'}</span><strong>${money(item.price_cents || item.priceCents)}</strong></div></div></article>`).join('') : emptyState('No products listed yet.');
  $('#overview-tasks').innerHTML = tasks.length ? tasks.slice(0, 6).map((task) => `<div class="data-row"><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.category || 'General')}</small></div><span>${money(task.payoutCents || task.payout_cents)}</span></div>`).join('') : emptyState('No active tasks right now.');
  const activity = [
    ...stores.map((store) => `<div class="data-row"><div><strong>${escapeHtml(store.businessName)}</strong><small>Store review · ${escapeHtml(store.reviewNote || store.status)}</small></div><span class="badge">${escapeHtml(store.status)}</span></div>`),
    ...orders.slice(0, 5).map((order) => `<div class="data-row"><div><strong>${escapeHtml(order.productTitle)}</strong><small>Incoming order · ${escapeHtml(order.status)}</small></div><span>${money(order.amountCents)}</span></div>`)
  ];
  $('#overview-vendor-activity').innerHTML = activity.length ? activity.slice(0, 8).join('') : emptyState('No store activity yet.');
  const topAd = (ads.ads || []).find((ad) => ['premium-product', 'premium-store', 'homepage-top', 'featured'].includes(ad.placement)) || (ads.ads || [])[0];
  showAd(topAd);
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

async function renderProductsLegacy() {
  const categories = await loadCategories();
  pageFrame('products', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Sell a product</h2><p class="panel-subtitle">Add product details, price, inventory, and media.</p></div></div><form id="product-form"><div class="field"><label for="product-title">Product title</label><input id="product-title" required minlength="3" maxlength="120"></div><div class="field"><label for="product-category">Category</label><select id="product-category" required>${categoryOptions(categories)}</select></div><div class="form-grid"><div class="field"><label for="product-price">Price (USD)</label><input id="product-price" type="number" min="0.01" step="0.01" value="25" required></div><div class="field"><label for="product-stock">Stock</label><input id="product-stock" type="number" min="0" value="10" required></div></div><div class="field"><label for="product-description">Description</label><textarea id="product-description" required></textarea></div><div class="field"><label for="product-media">Product images</label><input id="product-media" type="file" accept="image/*" multiple></div><button class="button button-primary" type="submit">List product</button></form></section><section class="panel"><div class="panel-head"><h2>Products</h2><span class="badge" id="product-count">0 products</span></div><div class="cards-grid" id="product-cards">${emptyState('Loading products...')}</div></section></div>`);
  const [productResponse, promotionResponse] = await Promise.all([
    api('/api/products').catch(() => ({ products: [] })),
    api('/api/promotions/requests/mine').catch(() => ({ requests: [] }))
  ]);
  const products = productResponse.products || [];
  const promotionByProduct = new Map((promotionResponse.requests || []).map((request) => [request.productId, request]));
  $('#product-count').textContent = `${products.length} products`;
  $('#product-cards').innerHTML = products.length ? products.map((product) => {
    const isOwner = String(product.vendor_id || product.vendorId) === String(currentUser?.id);
    const request = promotionByProduct.get(product.id);
    let promotionMarkup = '';
    if (isOwner && request) {
      const offer = request.offeredDays ? `${Number(request.offeredDays)} days · ${money(request.priceCents)}` : `${Number(request.requestedDays)} days requested`;
      promotionMarkup = `<p class="promotion-status"><strong>${escapeHtml(request.status)}</strong> · ${escapeHtml(offer)}${request.adminReply ? `<br>${escapeHtml(request.adminReply)}` : ''}</p>`;
    } else if (isOwner) {
      promotionMarkup = `<button class="button product-feature-action" type="button" data-product-promotion="${escapeHtml(product.id)}">Request 7-day homepage feature</button>`;
    }
    return `<article class="listing-card product-card">${mediaMarkup({ ...product, media: product.media || [] })}<div class="listing-body"><span class="badge">${escapeHtml(product.category || 'Product')}</span><h3>${escapeHtml(product.title)}</h3>${product.store_name ? `<div class="product-brand">${product.store_logo_url ? `<img src="${escapeHtml(product.store_logo_url)}" alt="">` : ''}<span>${escapeHtml(product.store_name)}</span></div>` : ''}<p class="listing-description">${escapeHtml(product.description || 'A quality product from the TaskFlow marketplace.')}</p><div class="listing-meta"><span class="product-rating">${Number(product.review_count || 0) ? `${Number(product.avg_rating || 0).toFixed(1)} ★ · ${Number(product.review_count)} reviews` : 'New arrival'}</span><strong>${money(product.price_cents || product.priceCents)}</strong></div><div class="listing-meta"><span class="badge">${Number(product.stock || 0)} in stock</span><button class="button" type="button" data-contact="product" data-id="${escapeHtml(product.id)}" data-title="${escapeHtml(product.title)}">Contact seller</button></div>${promotionMarkup}</div></article>`;
  }).join('') : emptyState('No products are listed yet.');
}

async function renderProducts() {
  const categories = await loadCategories();
  const storeResponse = await api('/api/store/me').catch(() => ({ stores: [] }));
  const approvedStores = (storeResponse.stores || []).filter((store) => store.status === 'verified');
  pageFrame('products', `
    <section class="panel product-catalog">
      <div class="panel-head product-catalog-head">
        <div><h2>Browse products</h2><p class="panel-subtitle">Find products from verified stores and independent sellers.</p></div>
        <div class="form-actions"><a class="button" href="/vendor" data-route="vendor"><i data-lucide="store"></i>My stores</a><button class="button button-primary" type="button" data-open-dialog="sell-product-dialog"><i data-lucide="plus"></i>Sell a product</button></div>
      </div>
      <div class="product-filters"><div class="field"><label for="product-search">Search products</label><input id="product-search" type="search" placeholder="Search products"></div><div class="field"><label for="product-category-filter">Category</label><select id="product-category-filter">${categoryOptions(categories, true)}</select></div><span class="badge" id="product-count">0 products</span></div>
      <div class="cards-grid product-catalog-grid" id="product-cards">${emptyState('Loading products...')}</div>
      <div class="product-catalog-footer"><span class="panel-subtitle">${approvedStores.length} approved ${approvedStores.length === 1 ? 'store' : 'stores'} available</span><div class="form-actions"><a class="button" href="#product-cards" data-scroll-products><i data-lucide="arrow-up"></i>Browse products</a><button class="button button-primary" type="button" data-open-dialog="sell-product-dialog"><i data-lucide="plus"></i>Sell a product</button></div></div>
    </section>
    <dialog class="modal-dialog" id="sell-product-dialog"><form id="product-form" class="panel modal-panel">
      <div class="panel-head"><div><h2>Sell a product</h2><p class="panel-subtitle">Add the details buyers need to make a decision.</p></div><button class="button icon-button" type="button" data-close-dialog aria-label="Close"><i data-lucide="x"></i></button></div>
      <div class="field"><label for="product-title">Product title</label><input id="product-title" required minlength="3" maxlength="120"></div>
      <div class="field"><label for="product-store">Store</label><select id="product-store"><option value="">Independent listing</option>${approvedStores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.businessName)}</option>`).join('')}</select></div>
      <div class="field"><label for="product-category">Category</label><select id="product-category" required>${categoryOptions(categories)}</select></div>
      <div class="form-grid"><div class="field"><label for="product-price">Price (USD)</label><input id="product-price" type="number" min="0.01" step="0.01" value="25" required></div><div class="field"><label for="product-stock">Stock</label><input id="product-stock" type="number" min="0" value="10" required></div></div>
      <div class="field"><label for="product-description">Description</label><textarea id="product-description" required></textarea></div>
      <div class="field"><label for="product-media">Product images</label><input id="product-media" type="file" accept="image/*" multiple></div>
      <div class="form-actions"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button button-primary" type="submit">List product</button></div>
    </form></dialog>`);
  const [productResponse, promotionResponse] = await Promise.all([
    api('/api/products').catch(() => ({ products: [] })),
    api('/api/promotions/requests/mine').catch(() => ({ requests: [] }))
  ]);
  const products = productResponse.products || [];
  const promotionByProduct = new Map((promotionResponse.requests || []).map((request) => [request.productId, request]));
  const renderCards = () => {
    const search = $('#product-search').value.trim().toLowerCase();
    const category = $('#product-category-filter').value;
    const filtered = products.filter((product) => `${product.title || ''} ${product.description || ''} ${product.category || ''} ${product.store_name || ''}`.toLowerCase().includes(search) && (!category || product.category === category));
    $('#product-count').textContent = `${filtered.length} products`;
    $('#product-cards').innerHTML = filtered.length ? filtered.map((product) => {
      const isOwner = String(product.vendor_id || product.vendorId) === String(currentUser?.id);
      const request = promotionByProduct.get(product.id);
      let promotionMarkup = '';
      if (isOwner && request) {
        const offer = request.offeredDays ? `${Number(request.offeredDays)} days · ${money(request.priceCents)}` : `${Number(request.requestedDays)} days requested`;
        promotionMarkup = `<p class="promotion-status"><strong>${escapeHtml(request.status)}</strong> · ${escapeHtml(offer)}${request.adminReply ? `<br>${escapeHtml(request.adminReply)}` : ''}</p>`;
      } else if (isOwner) {
        promotionMarkup = `<button class="button product-feature-action" type="button" data-product-promotion="${escapeHtml(product.id)}">Request 7-day homepage feature</button>`;
      }
      return `<article class="listing-card product-card">${mediaMarkup({ ...product, media: product.media || [] })}<div class="listing-body"><span class="badge">${escapeHtml(product.category || 'Product')}</span><h3>${escapeHtml(product.title)}</h3>${product.store_name ? `<div class="product-brand">${product.store_logo_url ? `<img src="${escapeHtml(product.store_logo_url)}" alt="">` : ''}<span>${escapeHtml(product.store_name)}</span></div>` : ''}<p class="listing-description">${escapeHtml(product.description || '')}</p><div class="listing-meta"><span class="product-rating">${Number(product.review_count || 0) ? `${Number(product.avg_rating || 0).toFixed(1)} ★ · ${Number(product.review_count)} reviews` : 'New arrival'}</span><strong>${money(product.price_cents || product.priceCents)}</strong></div><div class="product-stock-row"><span class="badge">${Number(product.stock || 0)} in stock</span><button class="button button-primary" type="button" data-buy-product="${escapeHtml(product.id)}" ${Number(product.stock || 0) < 1 || isOwner ? 'disabled' : ''}><i data-lucide="shopping-bag"></i>Buy product</button></div><button class="button product-contact" type="button" data-contact="product" data-id="${escapeHtml(product.id)}" data-title="${escapeHtml(product.title)}">Contact seller</button>${promotionMarkup}</div></article>`;
    }).join('') : emptyState('No products match these filters.');
    $('#product-cards').querySelectorAll('[data-buy-product]').forEach((button) => {
      const product = filtered.find((item) => String(item.id) === button.dataset.buyProduct);
      const brand = button.closest('.product-card')?.querySelector('.product-brand');
      if (product?.store_name && brand) brand.append(storePlanBadge(product.store_tier, product.store_green_tick));
    });
    window.lucide?.createIcons();
  };
  $('#product-search').addEventListener('input', renderCards);
  $('#product-category-filter').addEventListener('change', renderCards);
  renderCards();
}

async function renderGigs() {
  const categories = await loadCategories();
  pageFrame('gigs', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Create a gig</h2><p class="panel-subtitle">Offer a service with clear delivery expectations.</p></div></div><form id="gig-form"><div class="field"><label for="gig-title">Gig title</label><input id="gig-title" required minlength="3" maxlength="120" placeholder="Short-form video editing"></div><div class="field"><label for="gig-category">Category</label><select id="gig-category" required>${categoryOptions(categories)}</select></div><div class="form-grid"><div class="field"><label for="gig-price">Price (USD)</label><input id="gig-price" type="number" min="0.01" step="0.01" value="120" required></div><div class="field"><label for="gig-days">Delivery (days)</label><input id="gig-days" type="number" min="1" max="30" value="3" required></div></div><div class="field"><label for="gig-description">Description</label><textarea id="gig-description" required minlength="10"></textarea></div><button class="button button-primary" type="submit">Publish gig</button></form></section><section class="panel"><div class="panel-head"><h2>Available gigs</h2><span class="badge" id="gig-count">0 gigs</span></div><div class="cards-grid" id="gig-cards">${emptyState('Loading gigs...')}</div></section></div>`);
  const gigs = (await api('/api/gigs').catch(() => ({ gigs: [] }))).gigs || [];
  $('#gig-count').textContent = `${gigs.length} gigs`;
  $('#gig-cards').innerHTML = gigs.length ? gigs.map((gig) => `<article class="listing-card"><div class="listing-body"><h3>${escapeHtml(gig.title)}</h3><p>${escapeHtml(gig.description || '')}</p><div class="listing-meta"><span class="badge">${escapeHtml(gig.category || 'Service')}</span><strong>${money(gig.price_cents || gig.priceCents)}</strong></div><span class="badge">${Number(gig.delivery_days || gig.deliveryDays || 3)} day delivery</span></div></article>`).join('') : emptyState('No gigs are available yet.');
}

async function renderVendorLegacy() {
  pageFrame('vendor', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Build your storefront</h2><p class="panel-subtitle">Create a complete brand profile for buyers.</p></div><span class="badge" id="store-status">No request</span></div><form id="store-form"><div class="field"><label for="store-name">Business name</label><input id="store-name" required maxlength="120" placeholder="Your store name"></div><div class="field"><label for="store-category">Business type</label><select id="store-category" required><option value="">Choose a store type</option><option>Fashion & retail</option><option>Food & restaurants</option><option>Automotive</option><option>Electronics</option><option>Home & lifestyle</option><option>Digital products</option><option>Professional services</option><option>Other</option></select></div><div class="field"><label for="store-description">About your store</label><textarea id="store-description" required minlength="10" maxlength="1500" placeholder="Tell buyers what makes your store worth visiting."></textarea></div><div class="field"><label for="store-cover-file">Cover photo</label><input id="store-cover-file" type="file" accept="image/*"><input id="store-current-cover" type="hidden"><img id="store-cover-preview" class="store-cover-preview hidden" alt="Store cover preview"></div><div class="field"><label for="store-logo-file">Store profile picture</label><input id="store-logo-file" type="file" accept="image/*"><input id="store-current-logo" type="hidden"><img id="store-logo-preview" class="store-logo-preview hidden" alt="Store profile picture preview"></div><button class="button button-primary" type="submit">Submit storefront for review</button></form></section><div class="column"><section class="panel"><div class="panel-head"><h2>Inventory</h2><a class="button-quiet" href="/products" data-route="products">Add product</a></div><div id="vendor-inventory">${emptyState('Loading inventory...')}</div></section><section class="panel"><div class="panel-head"><h2>Incoming orders</h2></div><div id="vendor-orders">${emptyState('Loading orders...')}</div></section><section class="panel"><div class="panel-head"><h2>Alerts and messages</h2></div><div class="feed" id="vendor-notifications">${emptyState('Loading notifications...')}</div></section></div></div>`);
  const results = await Promise.all([api('/api/store/me').catch(() => ({ store: null })), api('/api/vendor/inventory').catch(() => ({ products: [] })), api('/api/vendor/orders').catch(() => ({ orders: [] })), api('/api/notifications').catch(() => ({ notifications: [] }))]);
  const [store, inventory, orders, notifications] = results;
  if (store.store) {
    $('#store-name').value = store.store.businessName || '';
    $('#store-category').value = store.store.category || '';
    $('#store-description').value = store.store.description || '';
    $('#store-current-logo').value = store.store.logoUrl || '';
    $('#store-current-cover').value = store.store.coverUrl || '';
    $('#store-logo-preview').src = store.store.logoUrl || '';
    $('#store-cover-preview').src = store.store.coverUrl || '';
    $('#store-logo-preview').classList.toggle('hidden', !store.store.logoUrl);
    $('#store-cover-preview').classList.toggle('hidden', !store.store.coverUrl);
    $('#store-status').textContent = store.store.status || 'Pending';
  }
  $('#store-logo-file').required = !store.store?.logoUrl;
  $('#store-cover-file').required = !store.store?.coverUrl;
  [['store-logo-file', 'store-logo-preview'], ['store-cover-file', 'store-cover-preview']].forEach(([inputId, previewId]) => {
    $(`#${inputId}`).addEventListener('change', (event) => {
      const [file] = event.target.files || [];
      if (!file) return;
      const preview = $(`#${previewId}`);
      if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
      preview.dataset.previewUrl = URL.createObjectURL(file);
      preview.src = preview.dataset.previewUrl;
      preview.classList.remove('hidden');
    });
  });
  $('#vendor-inventory').innerHTML = inventory.products?.length ? inventory.products.map((product) => `<div class="data-row"><div><strong>${escapeHtml(product.title)}</strong><small>${escapeHtml(product.category || 'Product')} · ${Number(product.stock)} in stock</small></div><span>${money(product.priceCents)}</span></div>`).join('') : emptyState('No products in your inventory.');
  $('#vendor-orders').innerHTML = orders.orders?.length ? orders.orders.map((order) => `<div class="data-row"><div><strong>${escapeHtml(order.productTitle)}</strong><small>${escapeHtml(order.status)}</small></div><span>${money(order.amountCents)}</span></div>`).join('') : emptyState('No incoming orders.');
  $('#vendor-notifications').innerHTML = notificationMarkup(notifications.notifications || []);
}

function openStoreForm(store = null) {
  const form = $('#store-form');
  form.reset();
  $('#store-id').value = store?.id || '';
  $('#store-name').value = store?.businessName || '';
  $('#store-category').value = store?.category || '';
  $('#store-description').value = store?.description || '';
  $('#store-current-logo').value = store?.logoUrl || '';
  $('#store-current-cover').value = store?.coverUrl || '';
  $('#store-logo-preview').src = store?.logoUrl || '';
  $('#store-cover-preview').src = store?.coverUrl || '';
  $('#store-logo-preview').classList.toggle('hidden', !store?.logoUrl);
  $('#store-cover-preview').classList.toggle('hidden', !store?.coverUrl);
  $('#store-logo-file').required = !store?.logoUrl;
  $('#store-cover-file').required = !store?.coverUrl;
  $('#store-dialog-title').textContent = store ? 'Update store request' : 'Create a new store';
  $('#store-form-submit').textContent = store ? 'Resubmit for review' : 'Submit storefront for review';
  $('#store-dialog').showModal();
}

async function openStoreMediaDialog(storeId) {
  const response = await api('/api/store/me');
  const store = (response.stores || []).find((item) => item.id === storeId);
  if (!store) throw new Error('Store not found for this account.');
  $('#store-media-id').value = store.id;
  $('#store-media-logo-preview').src = store.logoUrl || '';
  $('#store-media-cover-preview').src = store.coverUrl || '';
  $('#store-media-logo-preview').classList.toggle('hidden', !store.logoUrl);
  $('#store-media-cover-preview').classList.toggle('hidden', !store.coverUrl);
  $('#store-media-form').reset();
  $('#store-media-id').value = store.id;
  $('#store-media-dialog').showModal();
}

function openVendorProductEdit(product) {
  const form = $('#vendor-product-edit-form');
  form.reset();
  $('#vendor-product-id').value = product.id;
  $('#vendor-product-title').value = product.title || '';
  $('#vendor-product-category').value = product.category || '';
  $('#vendor-product-description').value = product.description || '';
  $('#vendor-product-price').value = Number(product.priceCents || product.price_cents || 0) / 100;
  $('#vendor-product-stock').value = Number(product.stock || 0);
  $('#vendor-product-media-preview').innerHTML = product.media?.length ? mediaMarkup({ title: product.title, media: product.media }) : emptyState('No product image.');
  $('#vendor-product-edit-dialog').showModal();
}

function openVendorAdForm(ad = null) {
  const form = $('#vendor-ad-form');
  form.reset();
  $('#vendor-ad-id').value = ad?.id || '';
  $('#vendor-ad-title').value = ad?.title || '';
  $('#vendor-ad-description').value = ad?.description || '';
  $('#vendor-ad-category').value = ad?.category || '';
  $('#vendor-ad-location').value = ad?.location || 'Global';
  $('#vendor-ad-price').value = Number(ad?.priceCents || 50000) / 100;
  $('#vendor-ad-placement').value = ad?.placement || 'homepage-top';
  $('#vendor-ad-duration').value = ad?.durationDays || 7;
  $('#vendor-ad-skip').value = String(ad?.skipAllowed ?? true);
  $('#vendor-ad-destination').value = ad?.destinationUrl || '';
  const media = Array.isArray(ad?.media) ? ad.media : [];
  $('#vendor-ad-existing-media').value = JSON.stringify(media);
  $('#vendor-ad-preview').innerHTML = media.length ? mediaMarkup({ title: ad.title, media }) : emptyState('No ad media selected.');
  $('#vendor-ad-title-text').textContent = ad ? 'Edit your advertisement' : 'Create an advertisement';
  $('#vendor-ad-submit').textContent = ad ? 'Save changes' : 'Submit for review';
  $('#vendor-ad-media').required = !ad;
  $('#vendor-ad-dialog').showModal();
  window.lucide?.createIcons();
}

async function renderVendorStore(storeId) {
  const detail = await api(`/api/store/me/${encodeURIComponent(storeId)}`);
  const target = $('#vendor-store-detail');
  $('#vendor-stores-panel').classList.add('hidden');
  target.classList.remove('hidden');
  const store = detail.store;
  const sales = detail.sales || {};
  vendorStoreProducts = new Map(detail.products.map((product) => [product.id, product]));
  target.innerHTML = `<section class="panel store-detail-panel"><img class="store-detail-cover" src="${escapeHtml(store.coverUrl || '')}" alt="${escapeHtml(store.businessName)} cover"><div class="store-profile"><img class="store-profile-image" src="${escapeHtml(store.logoUrl || '')}" alt=""><div><span class="badge">${escapeHtml(store.status)}</span><h2>${escapeHtml(store.businessName)}</h2><p>${escapeHtml(store.category || 'Store')}</p></div><button class="button" type="button" data-back-stores><i data-lucide="arrow-left"></i>All stores</button></div><p class="store-description">${escapeHtml(store.description)}</p><div class="metric-grid store-metrics"><article class="metric"><div class="metric-top"><span>Products</span><i data-lucide="package"></i></div><strong>${detail.products.length}</strong></article><article class="metric"><div class="metric-top"><span>Sales</span><i data-lucide="receipt-text"></i></div><strong>${Number(sales.salesCount || 0)}</strong></article><article class="metric"><div class="metric-top"><span>Units sold</span><i data-lucide="chart-no-axes-column-increasing"></i></div><strong>${Number(sales.unitsSold || 0)}</strong></article><article class="metric"><div class="metric-top"><span>Sales value</span><i data-lucide="circle-dollar-sign"></i></div><strong>${money(sales.salesCents)}</strong></article></div><div class="panel-head store-section-head"><h2>Store products</h2><a class="button button-primary" href="/products" data-route="products"><i data-lucide="plus"></i>Add product</a></div><div class="cards-grid">${detail.products.length ? detail.products.map((product) => `<article class="listing-card product-card">${mediaMarkup(product)}<div class="listing-body"><span class="badge">${escapeHtml(product.category || 'Product')}</span><h3>${escapeHtml(product.title)}</h3><p class="listing-description">${escapeHtml(product.description || '')}</p><div class="listing-meta"><span class="badge">${Number(product.stock)} in stock</span><strong>${money(product.priceCents)}</strong></div></div></article>`).join('') : emptyState('No products are assigned to this store yet.')}</div><div class="panel-head store-section-head"><h2>Recent sales</h2><span class="badge">${detail.orders.length} orders</span></div><div class="rows">${detail.orders.length ? detail.orders.map((order) => `<div class="data-row"><div><strong>${escapeHtml(order.productTitle)}</strong><small>${escapeHtml(order.status)} · ${Number(order.quantity)} units · ${new Date(order.createdAt).toLocaleDateString()}</small></div><span>${money(order.amountCents)}</span></div>`).join('') : emptyState('No sales for this store yet.')}</div></section>`;
  target.dataset.storeId = store.id;
  const productGrid = target.querySelector('.store-section-head').nextElementSibling;
  productGrid.querySelectorAll('.product-card').forEach((card, index) => {
    const product = detail.products[index];
    if (!product) return;
    const menu = document.createElement('details');
    menu.className = 'product-menu';
    menu.innerHTML = `<summary aria-label="Product actions" title="Product actions"><i data-lucide="more-horizontal"></i></summary><div class="product-menu-items"><button type="button" data-edit-product="${escapeHtml(product.id)}"><i data-lucide="pencil"></i>Edit product</button><button type="button" data-delete-product="${escapeHtml(product.id)}"><i data-lucide="trash-2"></i>Delete product</button></div>`;
    card.append(menu);
  });
  target.insertAdjacentHTML('beforeend', `<dialog class="modal-dialog" id="vendor-product-edit-dialog"><form id="vendor-product-edit-form" class="panel modal-panel"><div class="panel-head"><div><h2>Edit product</h2><p class="panel-subtitle">Changes apply only to this product.</p></div><button class="button icon-button" type="button" data-close-dialog aria-label="Close"><i data-lucide="x"></i></button></div><input id="vendor-product-id" type="hidden"><div class="field"><label for="vendor-product-title">Product title</label><input id="vendor-product-title" required minlength="3" maxlength="120"></div><div class="field"><label for="vendor-product-category">Category</label><input id="vendor-product-category" required minlength="2" maxlength="60"></div><div class="field"><label for="vendor-product-description">Description</label><textarea id="vendor-product-description" required minlength="5" maxlength="2000"></textarea></div><div class="form-grid"><div class="field"><label for="vendor-product-price">Price (USD)</label><input id="vendor-product-price" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="vendor-product-stock">Stock</label><input id="vendor-product-stock" type="number" min="0" max="1000000" required></div></div><div class="field"><label for="vendor-product-media">Replace product images (optional)</label><div id="vendor-product-media-preview"></div><input id="vendor-product-media" type="file" accept="image/*" multiple></div><div class="form-actions"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button button-primary" type="submit">Save product</button></div></form></dialog>`);
  const profileDetails = target.querySelector('.store-profile > div');
  profileDetails.append(storePlanBadge(currentUser?.subscriptionTier || currentUser?.subscription_tier, currentUser?.greenTick || currentUser?.green_tick));
  const mediaButton = document.createElement('button');
  mediaButton.className = 'button';
  mediaButton.type = 'button';
  mediaButton.dataset.changeStoreMedia = store.id;
  mediaButton.innerHTML = '<i data-lucide="image"></i>Change pictures';
  target.querySelector('[data-back-stores]').before(mediaButton);
  window.lucide?.createIcons();
}

async function renderVendor() {
  pageFrame('vendor', `
    <div class="stack">
      <section class="panel" id="vendor-stores-panel"><div class="panel-head"><div><h2>Your stores</h2><p class="panel-subtitle">Open an approved storefront or track requests under review.</p></div><button class="button button-primary" type="button" data-new-store><i data-lucide="plus"></i>Create new store</button></div><div class="cards-grid store-cards" id="vendor-stores">${emptyState('Loading stores...')}</div></section>
      <div class="hidden" id="vendor-store-detail"></div>
      <section class="panel"><div class="panel-head"><h2>Alerts and messages</h2></div><div class="feed" id="vendor-notifications">${emptyState('Loading notifications...')}</div></section>
    </div>
    <dialog class="modal-dialog" id="store-dialog"><form id="store-form" class="panel modal-panel">
      <div class="panel-head"><div><h2 id="store-dialog-title">Create a new store</h2><p class="panel-subtitle">Store requests are sent to the admin for approval.</p></div><button class="button icon-button" type="button" data-close-dialog aria-label="Close"><i data-lucide="x"></i></button></div>
      <input id="store-id" type="hidden"><div class="field"><label for="store-name">Business name</label><input id="store-name" required maxlength="120" placeholder="Your store name"></div>
      <div class="field"><label for="store-category">Business type</label><select id="store-category" required><option value="">Choose a store type</option><option>Fashion & retail</option><option>Food & restaurants</option><option>Automotive</option><option>Electronics</option><option>Home & lifestyle</option><option>Digital products</option><option>Professional services</option><option>Other</option></select></div>
      <div class="field"><label for="store-description">About your store</label><textarea id="store-description" required minlength="10" maxlength="1500" placeholder="Tell buyers what makes your store worth visiting."></textarea></div>
      <div class="field"><label for="store-cover-file">Cover photo</label><input id="store-cover-file" type="file" accept="image/*"><input id="store-current-cover" type="hidden"><img id="store-cover-preview" class="store-cover-preview hidden" alt="Store cover preview"></div>
      <div class="field"><label for="store-logo-file">Store profile picture</label><input id="store-logo-file" type="file" accept="image/*"><input id="store-current-logo" type="hidden"><img id="store-logo-preview" class="store-logo-preview hidden" alt="Store profile picture preview"></div>
      <div class="form-actions"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button button-primary" id="store-form-submit" type="submit">Submit storefront for review</button></div>
    </form></dialog>`);
  $('#vendor-stores-panel').insertAdjacentHTML('afterend', `<section class="panel vendor-ads-panel"><div class="panel-head"><div><h2>Your advertisements</h2><p class="panel-subtitle">Edit only ads submitted from your account. Vendor edits return to admin review.</p></div><button class="button button-primary" type="button" data-new-ad><i data-lucide="plus"></i>Create ad</button></div><div class="cards-grid ad-manager-grid" id="vendor-ad-list">${emptyState('Loading ads...')}</div></section>`);
  pageContent.insertAdjacentHTML('beforeend', `
    <dialog class="modal-dialog" id="store-media-dialog"><form id="store-media-form" class="panel modal-panel"><div class="panel-head"><div><h2>Change store pictures</h2><p class="panel-subtitle">Only this store's images will be updated.</p></div><button class="button icon-button" type="button" data-close-dialog aria-label="Close"><i data-lucide="x"></i></button></div><input id="store-media-id" type="hidden"><div class="field"><label for="store-media-cover">Cover photo</label><img id="store-media-cover-preview" class="store-cover-preview hidden" alt="Current cover"><input id="store-media-cover" type="file" accept="image/*"></div><div class="field"><label for="store-media-logo">Store profile picture</label><img id="store-media-logo-preview" class="store-logo-preview hidden" alt="Current store profile picture"><input id="store-media-logo" type="file" accept="image/*"></div><div class="form-actions"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button button-primary" type="submit">Save pictures</button></div></form></dialog>
    <dialog class="modal-dialog" id="vendor-ad-dialog"><form id="vendor-ad-form" class="panel modal-panel"><div class="panel-head"><div><h2 id="vendor-ad-title-text">Create an advertisement</h2><p class="panel-subtitle">Vendor-created ads are reviewed before publication.</p></div><button class="button icon-button" type="button" data-close-dialog aria-label="Close"><i data-lucide="x"></i></button></div><input id="vendor-ad-id" type="hidden"><input id="vendor-ad-existing-media" type="hidden"><div class="field"><label for="vendor-ad-title">Campaign title</label><input id="vendor-ad-title" required minlength="3" maxlength="120"></div><div class="field"><label for="vendor-ad-description">Description</label><textarea id="vendor-ad-description" required minlength="5" maxlength="2000"></textarea></div><div class="form-grid"><div class="field"><label for="vendor-ad-category">Category</label><select id="vendor-ad-category" required><option value="">Choose category</option><option>Technology</option><option>Marketing</option><option>Travel</option><option>Finance</option><option>Lifestyle</option><option>Education</option><option>Health</option><option>Retail</option><option>Real Estate</option><option>Food</option></select></div><div class="field"><label for="vendor-ad-location">Audience/location</label><input id="vendor-ad-location" required maxlength="120" value="Global"></div><div class="field"><label for="vendor-ad-price">Ad value (USD)</label><input id="vendor-ad-price" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="vendor-ad-placement">Placement</label><select id="vendor-ad-placement"><option value="homepage-top">Homepage top</option><option value="sidebar">Sidebar</option><option value="featured">Featured row</option></select></div><div class="field"><label for="vendor-ad-duration">Duration (days)</label><input id="vendor-ad-duration" type="number" min="1" max="365" value="7" required></div><div class="field"><label for="vendor-ad-skip">Allow skipping</label><select id="vendor-ad-skip"><option value="true">Yes</option><option value="false">No</option></select></div></div><div class="field"><label for="vendor-ad-media">Ad image or video</label><div id="vendor-ad-preview"></div><input id="vendor-ad-media" type="file" accept="image/*,video/*" multiple></div><div class="field"><label for="vendor-ad-destination">Destination link</label><input id="vendor-ad-destination" type="url" maxlength="500" placeholder="https://example.com"></div><div class="form-actions"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button button-primary" id="vendor-ad-submit" type="submit">Submit for review</button></div></form></dialog>`);
  const [storeResponse, notifications, adsResponse] = await Promise.all([
    api('/api/store/me').catch(() => ({ stores: [] })),
    api('/api/notifications').catch(() => ({ notifications: [] })),
    api('/api/ads/mine').catch(() => ({ ads: [] }))
  ]);
  const stores = storeResponse.stores || (storeResponse.store ? [storeResponse.store] : []);
  $('#vendor-stores').innerHTML = stores.length ? stores.map((store) => `<article class="listing-card store-card"><img class="store-card-cover" src="${escapeHtml(store.coverUrl || '')}" alt="${escapeHtml(store.businessName)} cover"><div class="store-card-body">${store.logoUrl ? `<img class="store-card-logo" src="${escapeHtml(store.logoUrl)}" alt="">` : ''}<div class="panel-head"><h3>${escapeHtml(store.businessName)}</h3><span class="badge">${escapeHtml(store.status)}</span></div><p>${escapeHtml(store.category || 'Store')}</p>${store.status === 'verified' ? `<button class="button button-primary" type="button" data-open-store="${escapeHtml(store.id)}"><i data-lucide="external-link"></i>Open store</button>` : `<div><small>${escapeHtml(store.reviewNote || (store.status === 'pending' ? 'Waiting for admin review.' : 'Update details and resubmit.'))}</small><button class="button" type="button" data-edit-store="${escapeHtml(store.id)}"><i data-lucide="pencil"></i>Update request</button></div>`}</div></article>`).join('') : emptyState('You have not created a store yet.');
  $('#vendor-stores').querySelectorAll('.store-card').forEach((card, index) => {
    const button = document.createElement('button');
    button.className = 'button store-media-action';
    button.type = 'button';
    button.dataset.changeStoreMedia = stores[index].id;
    button.innerHTML = '<i data-lucide="image"></i>Change pictures';
    card.querySelector('.store-card-body').append(button);
  });
  $('#vendor-stores').querySelectorAll('.store-card .panel-head').forEach((heading) => heading.append(storePlanBadge(currentUser?.subscriptionTier || currentUser?.subscription_tier, currentUser?.greenTick || currentUser?.green_tick)));
  const ads = adsResponse.ads || [];
  $('#vendor-ad-list').innerHTML = ads.length ? ads.map((ad) => `<article class="listing-card ad-manager-card">${mediaMarkup({ title: ad.title, media: ad.media || [] })}<div class="listing-body"><div class="panel-head"><h3>${escapeHtml(ad.title)}</h3><span class="badge">${escapeHtml(ad.status)}</span></div><p>${escapeHtml(ad.category)} · ${escapeHtml(ad.placement)} · ${Number(ad.durationDays)} days</p><div class="listing-meta"><strong>${money(ad.priceCents)}</strong><button class="button" type="button" data-edit-ad="${escapeHtml(ad.id)}"><i data-lucide="pencil"></i>Edit ad</button></div></div></article>`).join('') : emptyState('No advertisements from this account yet.');
  $('#vendor-notifications').innerHTML = notificationMarkup(notifications.notifications || []);
  [['store-logo-file', 'store-logo-preview'], ['store-cover-file', 'store-cover-preview']].forEach(([inputId, previewId]) => {
    $(`#${inputId}`).addEventListener('change', (event) => {
      const [file] = event.target.files || [];
      if (!file) return;
      const preview = $(`#${previewId}`);
      if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
      preview.dataset.previewUrl = URL.createObjectURL(file);
      preview.src = preview.dataset.previewUrl;
      preview.classList.remove('hidden');
    });
  });
  [['store-media-cover', 'store-media-cover-preview'], ['store-media-logo', 'store-media-logo-preview']].forEach(([inputId, previewId]) => {
    $(`#${inputId}`).addEventListener('change', (event) => {
      const [file] = event.target.files || [];
      if (!file) return;
      const preview = $(`#${previewId}`);
      if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
      preview.dataset.previewUrl = URL.createObjectURL(file);
      preview.src = preview.dataset.previewUrl;
      preview.classList.remove('hidden');
    });
  });
  $('#vendor-ad-media').addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) $('#vendor-ad-preview').textContent = `${files.length} new media ${files.length === 1 ? 'file' : 'files'} selected.`;
  });
  window.lucide?.createIcons();
}

async function renderWallet() {
  pageFrame('wallet', `<div class="stack"><section class="panel"><div class="panel-head"><div><h2>Wallet balance</h2><p class="panel-subtitle">Balances reflect verified platform transactions.</p></div><span class="badge">Secure</span></div><strong id="wallet-balance" style="font-size:32px;color:#0f172a">$0.00</strong></section><section class="panel"><div class="panel-head"><h2>Billing history</h2></div><div id="wallet-history">${emptyState('Loading transactions...')}</div></section><section class="panel"><div class="panel-head"><h2>Payment methods</h2><span class="badge">Stripe verification</span></div><p class="panel-subtitle">Add or verify a payment method from your account billing settings.</p><a class="button" href="/settings" data-route="settings">Open billing settings</a></section></div>`);
  const wallet = await api('/api/wallet').catch(() => ({ balanceCents: 0, transactions: [] }));
  $('#wallet-balance').textContent = money(wallet.balanceCents);
  $('#wallet-history').innerHTML = wallet.transactions?.length ? wallet.transactions.slice(0, 30).map((transaction) => `<div class="data-row"><div><strong>${escapeHtml(transaction.kind || 'Transaction')}</strong><small>${escapeHtml(transaction.status || 'Recorded')} · ${new Date(transaction.created_at || transaction.createdAt || Date.now()).toLocaleDateString()}</small></div><span>${money(transaction.amount_cents || transaction.amountCents)}</span></div>`).join('') : emptyState('No wallet activity yet.');
}

async function renderProfile() {
  pageFrame('profile', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><div><h2>Profile settings</h2><p class="panel-subtitle">Manage the details shown to clients and buyers.</p></div></div><form id="profile-form"><div class="field"><label for="profile-name">Display name</label><input id="profile-name" required maxlength="100"></div><div class="form-grid"><div class="field"><label for="profile-phone">Phone</label><input id="profile-phone" type="tel" placeholder="+1 555 0100"></div><div class="field"><label for="profile-country">Country</label><select id="profile-country"><option value="US">United States</option><option value="PK">Pakistan</option><option value="IN">India</option><option value="AE">United Arab Emirates</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="SA">Saudi Arabia</option><option value="BD">Bangladesh</option><option value="NG">Nigeria</option></select></div></div><div class="field"><label for="profile-bio">Bio</label><textarea id="profile-bio" rows="5" maxlength="500"></textarea></div><button class="button button-primary" type="submit">Save profile</button></form></section><section class="panel"><div class="panel-head"><h2>Account preview</h2><span class="badge">Active</span></div><div class="sidebar-user"><span class="avatar" data-user-initials>TF</span><span class="sidebar-user-copy"><strong data-user-name>Husnain</strong><small data-user-email>Account</small></span></div><div class="rows" style="margin-top:16px"><div class="data-row"><strong>Trust score</strong><span id="profile-trust">Not rated</span></div><div class="data-row"><strong>Account tier</strong><span id="profile-tier">Standard</span></div><div class="data-row"><strong>Member since</strong><span id="profile-joined">Active member</span></div></div></section></div>`);
  $('#profile-form').insertAdjacentHTML('afterbegin', `<div class="field profile-picture-field"><label for="profile-avatar-file">Profile picture</label><div class="profile-picture-control"><img id="profile-avatar-preview" class="profile-avatar-preview${currentUser?.avatarUrl || currentUser?.avatar_url ? '' : ' hidden'}" src="${escapeHtml(currentUser?.avatarUrl || currentUser?.avatar_url || '')}" alt="Current profile picture"><input id="profile-avatar-file" type="file" accept="image/*"><button class="button" type="button" data-save-profile-avatar><i data-lucide="image"></i>Change picture</button></div></div>`);
  const data = await api('/api/profile').catch(() => ({ user: currentUser }));
  const user = data.user || currentUser || {};
  $('#profile-name').value = user.name || '';
  $('#profile-phone').value = user.phone || '';
  $('#profile-country').value = user.country || 'US';
  $('#profile-bio').value = user.profile?.bio || user.bio || '';
  const avatarUrl = user.avatar_url || user.avatarUrl || '';
  $('#profile-avatar-preview').src = avatarUrl;
  $('#profile-avatar-preview').classList.toggle('hidden', !avatarUrl);
  $('#profile-avatar-file').addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    const preview = $('#profile-avatar-preview');
    if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
    preview.dataset.previewUrl = URL.createObjectURL(file);
    preview.src = preview.dataset.previewUrl;
    preview.classList.remove('hidden');
  });
  $('#profile-trust').textContent = user.trust_score == null && user.trustScore == null ? 'Not rated' : `${user.trust_score ?? user.trustScore}%`;
  $('#profile-tier').textContent = user.subscriptionTier || 'Standard';
  $('#profile-joined').textContent = user.created_at ? new Date(user.created_at).toLocaleDateString() : 'Active member';
}

async function renderSupport() {
  pageFrame('support', `
    <section class="support-hero">
      <h2><i data-lucide="headset"></i>Contact Support<i data-lucide="message-square-text"></i></h2>
      <p>We are here to help. Select a method to get in touch with our team.</p>
      <div class="support-actions"><button class="button" type="button" data-support-mode="agent"><i data-lucide="headset"></i>Speak with an Agent</button><button class="button button-primary" type="button" data-support-mode="assistant"><i data-lucide="messages-square"></i>Chat with Support</button></div>
    </section>
    <section class="panel support-panel hidden" id="support-agent-panel"><div class="panel-head"><div><h2>Message an Agent</h2><p class="panel-subtitle">Private support requests and replies stay in your account.</p></div><span class="badge">Private</span></div>
      <form id="support-form"><div class="field"><label for="support-subject">Subject</label><input id="support-subject" required minlength="3" maxlength="120" placeholder="What can we help with?"></div><div class="field"><label for="support-message">Message</label><textarea id="support-message" required rows="4" maxlength="2000" placeholder="Describe the issue or question."></textarea></div><button class="button button-primary" type="submit">Send to support</button></form>
      <div class="support-thread-area"><div class="panel-head"><h3>Your support conversations</h3><button class="button" type="button" data-support-refresh><i data-lucide="refresh-cw"></i>Refresh</button></div><div id="support-threads">${emptyState('Loading conversations...')}</div><div class="support-thread-messages" id="support-thread-messages">${emptyState('Select a conversation to view replies.')}</div><form id="support-reply-form" class="hidden"><div class="field"><label for="support-reply">Reply</label><textarea id="support-reply" maxlength="2000" required placeholder="Write a reply"></textarea></div><button class="button" type="submit">Send reply</button></form></div>
    </section>
    <section class="panel support-panel hidden" id="support-assistant-panel"><div class="panel-head"><div><h2>TaskFlow Support Chat</h2><p class="panel-subtitle">Ask about TaskFlow or search current products, tasks, listings, and gigs.</p></div><span class="badge">Site-aware help</span></div><div class="support-chat-log" id="support-chat-log" role="log" aria-live="polite"><p class="support-bubble">Hi! I can search the live TaskFlow catalog and help you find the right section. What are you looking for?</p></div><form id="support-chat-form" class="support-chat-form"><label class="hidden" for="support-chat-input">Ask TaskFlow Support</label><input id="support-chat-input" maxlength="500" autocomplete="off" placeholder="Ask a question or search the catalog" required><button class="button button-primary" type="submit" aria-label="Send message" title="Send message"><i data-lucide="arrow-up"></i></button></form></section>`);
  const threads = (await api('/api/support/threads').catch(() => ({ threads: [] }))).threads || [];
  $('#support-agent-panel').classList.toggle('hidden', supportMode !== 'agent');
  $('#support-assistant-panel').classList.toggle('hidden', supportMode !== 'assistant');
  $('#support-threads').innerHTML = threads.length ? threads.map((thread) => `<button class="support-thread-button${selectedSupportThreadId === thread.id ? ' is-selected' : ''}" type="button" data-support-thread="${escapeHtml(thread.id)}"><span><strong>${escapeHtml(thread.subject)}</strong><small>${escapeHtml(thread.lastMessage || 'No replies yet')}</small></span><span class="badge">${escapeHtml(thread.status)}</span></button>`).join('') : emptyState('No support conversations yet.');
  const selectedThread = threads.find((thread) => thread.id === selectedSupportThreadId);
  if (selectedThread) await loadSupportMessages(selectedThread.id, selectedThread.status);
  else {
    selectedSupportThreadId = null;
    $('#support-reply-form').classList.add('hidden');
    $('#support-thread-messages').innerHTML = emptyState('Select a conversation to view replies.');
  }
  window.lucide?.createIcons();
}

async function loadSupportMessages(threadId, status = 'open') {
  const response = await api(`/api/support/threads/${encodeURIComponent(threadId)}/messages`);
  $('#support-thread-messages').innerHTML = response.messages.length ? response.messages.map((message) => `<div class="support-thread-message"><strong>${escapeHtml(message.senderName || 'Support')}</strong><p>${escapeHtml(message.body)}</p><small>${new Date(message.createdAt).toLocaleString()}</small></div>`).join('') : emptyState('No messages in this conversation.');
  $('#support-reply-form').classList.toggle('hidden', status !== 'open' || !selectedSupportThreadId);
}

function appendSupportChatMessage(text, isUser, results = []) {
  const log = $('#support-chat-log');
  const bubble = document.createElement('div');
  bubble.className = `support-bubble${isUser ? ' user' : ''}`;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  bubble.append(paragraph);
  results.forEach((item) => {
    const link = document.createElement('a');
    link.className = 'support-result-link';
    link.href = item.href;
    link.dataset.route = item.route;
    link.textContent = `${item.title}${item.priceCents ? ` · ${money(item.priceCents)}` : ''}`;
    bubble.append(link);
  });
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
}

async function getSupportAssistantReply(question) {
  const text = question.toLowerCase();
  if (/sign.?in|log.?in|password|account|register|verification/.test(text)) return { text: 'For account access, use Sign in or Create account. Never share your password or verification code here. For account-specific help, choose Speak with an Agent.' };
  if (/payment|wallet|card|payout|withdraw|refund|billing/.test(text)) return { text: 'Open Wallet to review your balance and payment activity. For a specific transaction, choose Speak with an Agent; never share full card details.' };
  if (/premium|blue.?tick|referral/.test(text)) return { text: 'Open Premium to review your status and request. Premium can be activated after 10 verified referrals or admin approval of your Premium request; the blue tick appears with approved Premium status.', results: [{ title: 'Open Premium', href: '/premium', route: 'premium' }] };
  if (/store|vendor|storefront/.test(text)) return { text: 'Open Vendor dashboard to create a store and submit it for review. Verified stores open separately; each store keeps its own cover, profile image, details, products, and sales.', results: [{ title: 'Open Vendor dashboard', href: '/vendor', route: 'vendor' }] };
  if (/sell|buy|product|catalog/.test(text) && /how|where|create|list|sell|buy|purchase|browse/.test(text)) return { text: 'Open Products to browse and search current items. Use Sell a product to create a listing, or choose a product to see its available purchase action.', results: [{ title: 'Browse Products', href: '/products', route: 'products' }] };
  if (/task|gig|marketplace|listing/.test(text) && /how|where|create|find|browse|publish|post|open/.test(text)) {
    const route = /gig/.test(text) ? 'gigs' : /task/.test(text) ? 'tasks' : 'marketplace';
    const title = route === 'gigs' ? 'Open Gigs' : route === 'tasks' ? 'Open Tasks' : 'Open Marketplace';
    return { text: 'Use the matching section to browse available items or publish your own. I can also search the live catalog if you provide a name or category.', results: [{ title, href: `/${route}`, route }] };
  }
  if (/human|agent|person|support request/.test(text)) return { text: 'Choose Speak with an Agent to send a private message. Replies will appear in Your support conversations.' };

  const ignored = new Set(['about', 'browse', 'buy', 'can', 'create', 'find', 'for', 'from', 'get', 'help', 'how', 'list', 'looking', 'make', 'need', 'open', 'please', 'purchase', 'search', 'sell', 'show', 'some', 'that', 'the', 'this', 'want', 'where', 'which', 'with', 'what', 'you']);
  const terms = [...new Set((question.toLowerCase().match(/[a-z0-9-]{2,}/g) || []).filter((term) => !ignored.has(term)))].slice(0, 3);
  if (!terms.length) return { text: 'Tell me a product name, category, task, listing, or gig to search the live TaskFlow catalog.' };
  const responses = await Promise.all(terms.map((term) => api(`/api/search?q=${encodeURIComponent(term)}`).catch(() => ({}))));
  const kinds = [
    ['products', '/products', 'products'],
    ['listings', '/marketplace', 'listings'],
    ['tasks', '/tasks', 'tasks'],
    ['gigs', '/gigs', 'gigs']
  ];
  const seen = new Set();
  const results = [];
  responses.forEach((response) => kinds.forEach(([key, route, kind]) => (response[key] || []).filter((item) => !item.status || item.status === 'active').forEach((item) => {
    const id = `${kind}:${item.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    results.push({ title: item.title || kind, href: route, route: route.slice(1), priceCents: item.price_cents || item.priceCents || item.payout_cents || 0 });
  })));
  return results.length
    ? { text: `I found ${results.length} matching items in the live TaskFlow catalog:`, results: results.slice(0, 6) }
    : { text: 'I could not find a matching catalog item. Try a shorter product name or category, or choose Speak with an Agent for personal help.' };
}

async function renderSettings() {
  pageFrame('settings', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><h2>Account preferences</h2><span class="badge">Personal</span></div><div class="rows"><div class="data-row"><strong>Email address</strong><span>${escapeHtml(currentUser?.email || 'Not set')}</span></div><div class="data-row"><strong>Account role</strong><span>${escapeHtml(currentUser?.role || 'Member')}</span></div><div class="data-row"><strong>Account tier</strong><span>${escapeHtml(currentUser?.subscriptionTier || 'Standard')}</span></div></div><a class="button" href="/profile" data-route="profile">Edit profile</a></section><section class="panel"><div class="panel-head"><h2>Security</h2><span class="badge">Protected</span></div><div class="rows"><div class="data-row"><strong>Wallet security</strong><span>Enabled</span></div><div class="data-row"><strong>Payment verification</strong><span>Cloudflare + email OTP</span></div><div class="data-row"><strong>Session status</strong><span>Active</span></div></div><a class="button" href="/wallet" data-route="wallet">Wallet settings</a></section></div>`);
}

async function renderPremium() {
  pageFrame('premium', `<div class="dashboard-columns"><section class="panel"><div class="panel-head"><h2>Premium membership</h2><span class="badge">Account boost</span></div><p class="panel-subtitle">Priority visibility, a verified profile badge, and member benefits.</p><div class="trust-grid"><div class="trust-stat"><span>Visibility</span><strong>Priority placement</strong></div><div class="trust-stat"><span>Profile</span><strong>Premium badge</strong></div><div class="trust-stat"><span>Marketplace</span><strong>Member discounts</strong></div><div class="trust-stat"><span>Product promotion</span><strong>Request a 7-day homepage feature for your product</strong></div></div></section><section class="panel"><div class="panel-head"><h2>Premium status</h2><span class="badge" id="premium-state">Standard</span></div><p class="panel-subtitle">You can pay through checkout, qualify by referrals, or request owner review.</p><div class="form-actions"><button class="button button-primary" id="premium-pay" type="button">Upgrade to Premium</button><button class="button" id="premium-referrals" type="button">View referrals</button><button class="button" id="premium-request" type="button">Request Premium</button></div><p class="panel-subtitle" id="premium-note"></p></section></div>`);
  $('#premium-state').textContent = currentUser?.subscriptionTier || 'Standard';
}

function adminTable(title, rows, emptyMessage = 'Nothing to review.') {
  return `<section class="panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span class="badge">${rows.length} records</span></div><div class="table-wrap"><table><thead><tr><th>Record</th><th>Owner / details</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td><strong>${escapeHtml(row.title || row.name || row.businessName || row.subject || row.kind || row.id)}</strong><br><small>${escapeHtml(row.id || '')}</small>${row.coverUrl ? `<img class="admin-review-media" src="${escapeHtml(row.coverUrl)}" alt="Store cover">` : ''}${row.logoUrl ? `<img class="admin-review-media" src="${escapeHtml(row.logoUrl)}" alt="Store profile picture">` : ''}</td><td>${escapeHtml(row.owner_name || row.ownerName || row.ownerEmail || row.email || row.category || '')}${row.details ? `<details class="admin-review-details"><summary>Inspect full details</summary><p>${escapeHtml(row.details)}</p>${row.media?.length ? mediaMarkup({ title: row.title, media: row.media }) : ''}</details>` : row.description ? `<details class="admin-review-details"><summary>Inspect full details</summary><p>${escapeHtml(row.description)}</p>${row.media?.length ? mediaMarkup({ title: row.title, media: row.media }) : ''}</details>` : row.media?.length ? mediaMarkup({ title: row.title, media: row.media }) : ''}</td><td><span class="badge">${escapeHtml(row.status || row.accountStatus || 'active')}</span></td><td>${row.action || '<span class="badge">View</span>'}</td></tr>`).join('') : `<tr><td colspan="4">${escapeHtml(emptyMessage)}</td></tr>`}</tbody></table></div></section>`;
}

async function renderAdmin() {
  if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
    navigate('overview');
    notify('Admin access is required.');
    return;
  }
  pageFrame('admin', `<div class="metric-grid" id="admin-metrics">${['Users', 'Products', 'Listings', 'Gigs'].map((label) => `<article class="metric"><div class="metric-top"><span>${label}</span><i data-lucide="bar-chart-3"></i></div><strong>...</strong><small>Loading owner data</small></article>`).join('')}</div><div class="stack" id="admin-content"><section class="panel"><p class="empty">Loading complete platform control center...</p></section></div>`,'Owner control center');
  const [overview, content, users, stores, support, reports, categories, ads, adMessages, premiumRequests, promotionRequests] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/content'), api('/api/admin/users'), api('/api/admin/store-requests'), api('/api/admin/support/threads'), api('/api/admin/reports'), api('/api/admin/categories'), api('/api/admin/ads'), api('/api/admin/ad-messages'), api('/api/admin/premium-requests'), api('/api/admin/promotion-requests')
  ]);
  const stats = overview.stats || {};
  const metrics = [stats.activeUsers || 0, stats.activeProducts || 0, content.listings?.length || 0, stats.activeGigs || 0];
  document.querySelectorAll('#admin-metrics .metric strong').forEach((element, index) => { element.textContent = String(metrics[index]); });
  const action = (type, id, label = 'Delete') => `<button class="button" type="button" data-admin-delete="${type}" data-id="${escapeHtml(id)}">${label}</button>`;
  const userRows = (users.users || []).map((user) => ({ ...user, action: user.role === 'admin' ? '<span class="badge">Protected owner</span>' : `<button class="button" type="button" data-premium-user="${escapeHtml(user.id)}" data-enabled="${user.subscriptionTier === 'premium'}">${user.subscriptionTier === 'premium' ? 'Revoke Premium' : 'Grant Premium'}</button> ${action('users', user.id, 'Remove')}` }));
  const taskRows = (content.tasks || []).map((task) => ({ ...task, action: action('tasks', task.id) }));
  const productRows = (content.products || []).map((product) => ({ ...product, action: action('products', product.id) }));
  const listingRows = (content.listings || []).map((listing) => ({ ...listing, action: action('listings', listing.id) }));
  const gigRows = (content.gigs || []).map((gig) => ({ ...gig, action: action('gigs', gig.id) }));
  const storeRows = (stores.requests || []).map((store) => ({ ...store, owner_name: store.ownerName || store.ownerEmail, details: `${store.category || 'Store'}\n${store.description || ''}`, action: store.status === 'pending' ? `<button class="button" type="button" data-store-review="${escapeHtml(store.id)}" data-decision="verified">Verify</button> <button class="button" type="button" data-store-review="${escapeHtml(store.id)}" data-decision="rejected">Changes</button>` : '<span class="badge">Reviewed</span>' }));
  const adRows = (ads.ads || []).map((ad) => ({ ...ad, details: `${ad.category || ''} · ${ad.placement || ''} · ${Number(ad.duration_days || 7)} days\n${ad.description || ''}`, action: `<button class="button" type="button" data-ad-review="${escapeHtml(ad.id)}" data-decision="approved">Approve</button> <button class="button" type="button" data-ad-review="${escapeHtml(ad.id)}" data-decision="rejected">Reject</button> <button class="button" type="button" data-admin-delete="ads" data-id="${escapeHtml(ad.id)}">Delete</button>` }));
  const adMessageRows = (adMessages.messages || []).map((message) => ({ ...message, title: message.adTitle || 'Advertisement message', owner_name: `${message.senderName || 'User'} · ${message.senderEmail || 'No email'}`, details: message.body, action: `<button class="button" type="button" data-ad-message-review="${escapeHtml(message.id)}" data-decision="approved">Approve</button> <button class="button" type="button" data-ad-message-review="${escapeHtml(message.id)}" data-decision="rejected">Reject</button>` }));
  const promotionRows = (promotionRequests.requests || []).map((request) => ({
    ...request,
    title: request.productTitle,
    owner_name: `${request.userName || 'User'} · ${request.userEmail || ''}`,
    description: request.productDescription,
    media: request.media,
    details: `${request.category || 'Product'} · ${money(request.productPriceCents)}\nRequested: ${Number(request.requestedDays)} days${request.adminReply ? `\nAdmin reply: ${request.adminReply}` : ''}`,
    action: request.status === 'pending' ? `<form class="promotion-review-form" data-promotion-review-form><input type="hidden" name="requestId" value="${escapeHtml(request.id)}"><label>Feature days<input name="offeredDays" type="number" min="1" max="30" value="${Number(request.requestedDays) || 7}" required></label><label>Price (USD)<input name="priceDollars" type="number" min="0" step="0.01" value="0" required></label><label>Reply to customer<textarea name="reply" maxlength="1000" required placeholder="Explain the schedule and any terms."></textarea></label><div class="promotion-review-actions"><button class="button button-primary" type="submit" name="decision" value="approved">Approve / send quote</button><button class="button" type="submit" name="decision" value="rejected">Reject</button></div></form>` : '<span class="badge">Reviewed</span>'
  }));
  const premiumRows = (premiumRequests.requests || []).map((request) => ({ ...request, title: request.userName, ownerEmail: request.userEmail, action: request.status === 'pending' ? `<button class="button" type="button" data-premium-review="${escapeHtml(request.id)}" data-decision="approved">Approve</button> <button class="button" type="button" data-premium-review="${escapeHtml(request.id)}" data-decision="rejected">Reject</button>` : '<span class="badge">Reviewed</span>' }));
  $('#admin-content').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>Create third-party ad</h2><p class="panel-subtitle">Upload a banner or video and choose where it appears.</p></div><span class="badge">Admin only</span></div><form id="admin-ad-form" class="form-grid"><div class="field"><label for="admin-ad-title">Campaign title</label><input id="admin-ad-title" required minlength="3" maxlength="120"></div><div class="field"><label for="admin-ad-category">Category</label><select id="admin-ad-category" required>${categoryOptions(categories.categories || [])}</select></div><div class="field"><label for="admin-ad-placement">Placement</label><select id="admin-ad-placement" required><option value="homepage-top">Homepage top</option><option value="sidebar">Sidebar</option><option value="featured">Featured</option></select></div><div class="field"><label for="admin-ad-duration">Campaign duration (days)</label><input id="admin-ad-duration" type="number" min="1" max="365" value="7" required></div><div class="field field-full"><label for="admin-ad-description">Description</label><textarea id="admin-ad-description" required minlength="5"></textarea></div><div class="field"><label for="admin-ad-media">Picture or video</label><input id="admin-ad-media" type="file" accept="image/*,video/*" required></div><div class="field"><label for="admin-ad-skip">Skip ad</label><select id="admin-ad-skip"><option value="true">Allow skip after 3 seconds</option><option value="false">Do not allow skip</option></select></div><div class="field-full"><button class="button button-primary" type="submit">Publish ad</button></div></form></section>${adminTable('Product homepage feature requests', promotionRows, 'No product promotion requests.')}${adminTable('Premium requests', premiumRows, 'No Premium requests.')}${adminTable('Users', userRows, 'No registered users.')}${adminTable('Tasks', taskRows)}${adminTable('Products', productRows)}${adminTable('Marketplace listings', listingRows)}${adminTable('Gigs', gigRows)}${adminTable('Advertisement review', adRows, 'No ads awaiting or needing review.')}${adminTable('Advertisement messages', adMessageRows, 'No ad messages.')}${adminTable('Store requests', storeRows)}${adminTable('Support inbox', support.threads || [])}${adminTable('Reports', reports.reports || [])}${adminTable('Categories', categories.categories || [])}<section class="panel"><div class="panel-head"><div><h2>Platform totals</h2><p class="panel-subtitle">Owner-only operational visibility.</p></div><span class="badge">Protected API</span></div><div class="rows"><div class="data-row"><strong>Open disputes</strong><span>${Number(stats.openDisputes || 0)}</span></div><div class="data-row"><strong>Open reports</strong><span>${Number(stats.openReports || 0)}</span></div><div class="data-row"><strong>Active ads</strong><span>${Number(stats.activeAds || 0)}</span></div><div class="data-row"><strong>Categories</strong><span>${Number(stats.categories || 0)}</span></div></div></section>`;
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
    if (form.id === 'support-chat-form') {
      const input = $('#support-chat-input');
      const question = input.value.trim();
      if (!question) return;
      appendSupportChatMessage(question, true);
      input.value = '';
      input.disabled = true;
      try {
        const answer = await getSupportAssistantReply(question);
        appendSupportChatMessage(answer.text, false, answer.results || []);
      } finally {
        input.disabled = false;
        input.focus();
      }
      return;
    } else if (form.id === 'support-reply-form') {
      await api(`/api/support/threads/${encodeURIComponent(selectedSupportThreadId)}/messages`, { method: 'POST', body: JSON.stringify({ body: value('support-reply') }) });
      notify('Reply sent.');
      await renderSupport();
      return;
    } else if (form.id === 'vendor-product-edit-form') {
      const files = await uploadFiles($('#vendor-product-media', form).files);
      const payload = {
        title: value('vendor-product-title'),
        category: value('vendor-product-category'),
        description: value('vendor-product-description'),
        priceCents: Math.round(Number(value('vendor-product-price')) * 100),
        stock: Number(value('vendor-product-stock'))
      };
      if (files.length) payload.media = files.map((file) => file.url);
      await api(`/api/vendor/products/${encodeURIComponent(value('vendor-product-id'))}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const storeId = $('#vendor-store-detail').dataset.storeId;
      notify('Product updated.');
      await renderVendorStore(storeId);
      return;
    } else if (form.id === 'task-form' || form.id === 'quick-task-form') {
      const quick = form.id === 'quick-task-form';
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: value(quick ? 'quick-title' : 'task-title'), videoUrl: value(quick ? 'quick-video' : 'task-video'), category: value(quick ? 'quick-category' : 'task-category'), description: value(quick ? 'quick-description' : 'task-description'), instructions: value('task-instructions'), amountDollars: Number(value(quick ? 'quick-budget' : 'task-budget')), seconds: 60 }) });
      notify('Task published successfully.');
    } else if (form.id === 'listing-form') {
      const files = await uploadFiles($('#listing-media', form).files);
      await api('/api/listings', { method: 'POST', body: JSON.stringify({ title: value('listing-title'), type: value('listing-type'), category: value('listing-category'), priceCents: Math.round(Number(value('listing-price')) * 100), media: files.map((file) => ({ url: file.url, mimeType: file.mimeType })) }) });
      notify('Marketplace listing published.');
    } else if (form.id === 'product-form') {
      const files = await uploadFiles($('#product-media', form).files);
      await api('/api/products', { method: 'POST', body: JSON.stringify({ title: value('product-title'), storeId: value('product-store') || undefined, category: value('product-category'), description: value('product-description'), priceDollars: Number(value('product-price')), stock: Number(value('product-stock')), media: files.map((file) => file.url) }) });
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
      const response = await api('/api/support/threads', { method: 'POST', body: JSON.stringify({ subject: value('support-subject'), body: value('support-message') }) });
      selectedSupportThreadId = response.thread.id;
      supportMode = 'agent';
      notify('Your message was sent to support.');
    } else if (form.id === 'store-form') {
      let logoUrl = value('store-current-logo');
      let coverUrl = value('store-current-cover');
      const [logo, cover] = [$('#store-logo-file', form).files?.[0], $('#store-cover-file', form).files?.[0]];
      const uploads = await uploadFiles([logo, cover].filter(Boolean));
      let uploadIndex = 0;
      if (logo) logoUrl = uploads[uploadIndex++]?.url || '';
      if (cover) coverUrl = uploads[uploadIndex]?.url || '';
      if (!logoUrl || !coverUrl) throw new Error('Add both a store profile picture and a cover photo.');
      const storeId = value('store-id');
      await api(storeId ? `/api/store/me/${encodeURIComponent(storeId)}` : '/api/store/me', { method: storeId ? 'PUT' : 'POST', body: JSON.stringify({ businessName: value('store-name'), category: value('store-category'), description: value('store-description'), logoUrl, coverUrl }) });
      notify('Store submitted for review.');
    } else if (form.id === 'store-media-form') {
      const [logo, cover] = [$('#store-media-logo', form).files?.[0], $('#store-media-cover', form).files?.[0]];
      const files = await uploadFiles([logo, cover].filter(Boolean));
      if (!files.length) throw new Error('Choose a new profile picture or cover photo.');
      const media = {};
      let index = 0;
      if (logo) media.logoUrl = files[index++].url;
      if (cover) media.coverUrl = files[index].url;
      await api(`/api/store/me/${encodeURIComponent(value('store-media-id'))}/media`, { method: 'PATCH', body: JSON.stringify(media) });
      notify('Store pictures updated. Other store details and approval status were preserved.');
    } else if (form.id === 'vendor-ad-form') {
      const adId = value('vendor-ad-id');
      const files = await uploadFiles($('#vendor-ad-media', form).files);
      const oldMedia = JSON.parse(value('vendor-ad-existing-media') || '[]');
      const media = files.length ? files.map((file) => ({ url: file.url, mimeType: file.mimeType })) : oldMedia;
      if (!media.length) throw new Error('Choose an image or video for the ad.');
      const payload = { title: value('vendor-ad-title'), description: value('vendor-ad-description'), category: value('vendor-ad-category'), location: value('vendor-ad-location'), priceCents: Math.round(Number(value('vendor-ad-price')) * 100), placement: value('vendor-ad-placement'), durationDays: Number(value('vendor-ad-duration')), skipAllowed: value('vendor-ad-skip') === 'true', media, destinationUrl: value('vendor-ad-destination') || null };
      const response = await api(adId ? `/api/ads/${encodeURIComponent(adId)}` : '/api/ads', { method: adId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      notify(response.submittedForReview ? 'Ad saved and sent for admin review.' : 'Ad saved successfully.');
    } else if (form.matches('[data-promotion-review-form]')) {
      const field = (name) => form.elements.namedItem(name)?.value || '';
      const decision = event.submitter?.value;
      const result = await api(`/api/admin/promotion-requests/${encodeURIComponent(field('requestId'))}/review`, {
        method: 'PATCH',
        body: JSON.stringify({ decision, offeredDays: Number(field('offeredDays')), priceCents: Math.round(Number(field('priceDollars')) * 100), reply: field('reply') })
      });
      notify(result.status === 'approved' ? 'Product feature approved and scheduled.' : result.status === 'quoted' ? 'Promotion quote sent to the customer.' : 'Promotion request declined.');
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
  const supportModeButton = event.target.closest('[data-support-mode]');
  if (supportModeButton) {
    supportMode = supportModeButton.dataset.supportMode;
    $('#support-agent-panel').classList.toggle('hidden', supportMode !== 'agent');
    $('#support-assistant-panel').classList.toggle('hidden', supportMode !== 'assistant');
    const focusTarget = supportMode === 'agent' ? $('#support-subject') : $('#support-chat-input');
    focusTarget?.focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('[data-support-refresh]')) { await renderSupport(); return; }
  const supportThreadButton = event.target.closest('[data-support-thread]');
  if (supportThreadButton) {
    selectedSupportThreadId = supportThreadButton.dataset.supportThread;
    supportMode = 'agent';
    await renderSupport();
    return;
  }
  if (event.target.closest('#sign-out')) {
    try { await api('/api/auth/logout', { method: 'POST' }); location.assign('/'); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('[data-refresh-overview]')) { await renderOverview(); return; }
  const dialogTrigger = event.target.closest('[data-open-dialog]');
  if (dialogTrigger) { $(`#${dialogTrigger.dataset.openDialog}`).showModal(); return; }
  if (event.target.closest('[data-close-dialog]')) { event.target.closest('dialog')?.close(); return; }
  if (event.target.closest('[data-save-profile-avatar]')) {
    const [file] = $('#profile-avatar-file').files || [];
    if (!file) { notify('Choose a profile picture first.'); return; }
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await api('/api/profile/avatar', { method: 'POST', body: formData });
      const uploadedImage = new Image();
      uploadedImage.src = result.url;
      try {
        await uploadedImage.decode();
      } catch {
        throw new Error('The image was saved but could not be displayed. Check that UPLOAD_DIR points to the mounted Railway volume.');
      }
      currentUser = { ...currentUser, avatarUrl: result.url, avatar_url: result.url };
      setShellUser(currentUser);
      $('#profile-avatar-preview').src = result.url;
      notify('Profile picture updated across your account.');
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('[data-new-store]')) { openStoreForm(); return; }
  if (event.target.closest('[data-new-ad]')) { openVendorAdForm(); return; }
  const editAdButton = event.target.closest('[data-edit-ad]');
  if (editAdButton) {
    try {
      const response = await api('/api/ads/mine');
      const ad = (response.ads || []).find((item) => item.id === editAdButton.dataset.editAd);
      if (!ad) throw new Error('Ad not found for this account.');
      openVendorAdForm(ad);
    } catch (error) { notify(error.message); }
    return;
  }
  const changeStoreMediaButton = event.target.closest('[data-change-store-media]');
  if (changeStoreMediaButton) {
    try { await openStoreMediaDialog(changeStoreMediaButton.dataset.changeStoreMedia); }
    catch (error) { notify(error.message); }
    return;
  }
  const editStoreButton = event.target.closest('[data-edit-store]');
  if (editStoreButton) {
    try {
      const response = await api('/api/store/me');
      const store = (response.stores || []).find((item) => item.id === editStoreButton.dataset.editStore);
      if (store) openStoreForm(store);
    } catch (error) { notify(error.message); }
    return;
  }
  const openStoreButton = event.target.closest('[data-open-store]');
  if (openStoreButton) {
    try { await renderVendorStore(openStoreButton.dataset.openStore); }
    catch (error) { notify(error.message); }
    return;
  }
  const editProductButton = event.target.closest('[data-edit-product]');
  if (editProductButton) {
    const product = vendorStoreProducts.get(editProductButton.dataset.editProduct);
    if (product) openVendorProductEdit(product);
    else notify('Product not found in this store.');
    return;
  }
  const deleteProductButton = event.target.closest('[data-delete-product]');
  if (deleteProductButton) {
    if (!window.confirm('Remove this product from the store? Existing orders and sales history will be preserved.')) return;
    try {
      await api(`/api/vendor/products/${encodeURIComponent(deleteProductButton.dataset.deleteProduct)}`, { method: 'DELETE' });
      notify('Product removed from the store. Existing sales history was preserved.');
      await renderVendorStore($('#vendor-store-detail').dataset.storeId);
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest('[data-back-stores]')) {
    $('#vendor-store-detail').classList.add('hidden');
    $('#vendor-stores-panel').classList.remove('hidden');
    return;
  }
  const buyProductButton = event.target.closest('[data-buy-product]');
  if (buyProductButton) {
    const quantity = Number(window.prompt('Quantity to buy', '1'));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return;
    try {
      await api(`/api/products/${encodeURIComponent(buyProductButton.dataset.buyProduct)}/purchase`, { method: 'POST', body: JSON.stringify({ quantity }) });
      notify('Product purchased successfully.');
      await renderProducts();
    } catch (error) { notify(error.message); }
    return;
  }
  const promotionButton = event.target.closest('[data-product-promotion]');
  if (promotionButton) {
    if (currentUser?.subscriptionTier !== 'premium') {
      notify('Premium is required before you can request a homepage product feature.');
      navigate('premium');
      return;
    }
    try {
      await api('/api/promotions/requests', { method: 'POST', body: JSON.stringify({ productId: promotionButton.dataset.productPromotion, requestedDays: 7 }) });
      notify('Your 7-day product feature request was sent to the admin team.');
      await renderProducts();
    } catch (error) { notify(error.message); }
    return;
  }
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
  const premiumButton = event.target.closest('[data-premium-user]');
  if (premiumButton) {
    try {
      const enabled = premiumButton.dataset.enabled !== 'true';
      await api(`/api/admin/users/${encodeURIComponent(premiumButton.dataset.premiumUser)}/premium`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      notify(enabled ? 'Premium and verified blue tick granted.' : 'Premium and verified blue tick revoked.');
      await renderAdmin();
    } catch (error) { notify(error.message); }
    return;
  }
  const premiumReview = event.target.closest('[data-premium-review]');
  if (premiumReview) {
    try {
      await api(`/api/admin/premium-requests/${encodeURIComponent(premiumReview.dataset.premiumReview)}/review`, { method: 'POST', body: JSON.stringify({ decision: premiumReview.dataset.decision }) });
      notify(premiumReview.dataset.decision === 'approved' ? 'Premium approved and blue tick enabled.' : 'Premium request rejected.');
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
  const adReview = event.target.closest('[data-ad-review]');
  if (adReview) {
    try {
      await api(`/api/admin/ads/${encodeURIComponent(adReview.dataset.adReview)}/review`, { method: 'PATCH', body: JSON.stringify({ decision: adReview.dataset.decision }) });
      notify(adReview.dataset.decision === 'approved' ? 'Ad approved and made live.' : 'Ad rejected and hidden.');
      await renderAdmin();
    } catch (error) { notify(error.message); }
    return;
  }
  const adMessageReview = event.target.closest('[data-ad-message-review]');
  if (adMessageReview) {
    try {
      await api(`/api/admin/ad-messages/${encodeURIComponent(adMessageReview.dataset.adMessageReview)}/review`, { method: 'PATCH', body: JSON.stringify({ decision: adMessageReview.dataset.decision }) });
      notify(adMessageReview.dataset.decision === 'approved' ? 'Message approved.' : 'Message rejected.');
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
  if (event.target.closest('#premium-request')) {
    try {
      await api('/api/premium/requests', { method: 'POST', body: JSON.stringify({ reason: 'Please review my account for Premium access.' }) });
      notify('Premium request sent to the owner.');
      $('#premium-note').textContent = 'Your request is pending owner review.';
    } catch (error) { notify(error.message); }
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
