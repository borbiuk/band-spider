// Live updates: the server says "status" when something changed and sends new log text.
(function () {
	var MAX_LOG_CHARS = 200000;
	var connection = document.getElementById('connection');
	var connectionText = document.getElementById('connection-text');


	// --- "morph" swap: the new HTML is applied to the old elements, so focus, hover and open menus stay ---

	function keyOf(node) {
		return node.nodeType === 1 ? node.getAttribute('data-key') || node.id || null : null;
	}

	function syncAttributes(from, to) {
		// the user opens and closes a <details> by hand, the server does not know it
		var skipOpen = from.nodeName === 'DETAILS';
		Array.prototype.slice.call(to.attributes).forEach(function (attr) {
			if (!(skipOpen && attr.name === 'open') && from.getAttribute(attr.name) !== attr.value) {
				from.setAttribute(attr.name, attr.value);
			}
		});
		Array.prototype.slice.call(from.attributes).forEach(function (attr) {
			if (!(skipOpen && attr.name === 'open') && !to.hasAttribute(attr.name)) {
				from.removeAttribute(attr.name);
			}
		});
	}

	function morphNode(from, to) {
		if (from.nodeType !== 1) {
			if (from.nodeValue !== to.nodeValue) {
				from.nodeValue = to.nodeValue;
			}
			return;
		}
		syncAttributes(from, to);
		morphChildren(from, to);
	}

	function morphChildren(from, to) {
		// A parent with data-keep-order keeps the order its rows have now (the script sorts them), only new rows are added
		var keepOrder = from.nodeType === 1 && from.hasAttribute('data-keep-order');
		var keyed = {};
		Array.prototype.forEach.call(from.childNodes, function (node) {
			var key = keyOf(node);
			if (key) {
				keyed[key] = node;
			}
		});
		if (keepOrder) {
			var present = {};
			Array.prototype.slice.call(to.childNodes).forEach(function (next) {
				var key = keyOf(next);
				if (key && keyed[key] && keyed[key].nodeName === next.nodeName) {
					present[key] = true;
					morphNode(keyed[key], next);
				} else {
					from.appendChild(next);
				}
			});
			Array.prototype.slice.call(from.childNodes).forEach(function (node) {
				var key = keyOf(node);
				if (key && keyed[key] === node && !present[key]) {
					from.removeChild(node);
				}
			});
			return;
		}
		var position = 0;
		Array.prototype.slice.call(to.childNodes).forEach(function (next) {
			var key = keyOf(next);
			var match = null;
			if (key) {
				match = keyed[key] && keyed[key].nodeName === next.nodeName ? keyed[key] : null;
			} else {
				var candidate = from.childNodes[position];
				if (candidate && !keyOf(candidate) && candidate.nodeName === next.nodeName) {
					match = candidate;
				}
			}
			if (match) {
				if (from.childNodes[position] !== match) {
					from.insertBefore(match, from.childNodes[position] || null);
				}
				morphNode(match, next);
			} else {
				from.insertBefore(next, from.childNodes[position] || null);
			}
			position++;
		});
		while (from.childNodes.length > position) {
			from.removeChild(from.lastChild);
		}
	}

	htmx.defineExtension('morph', {
		isInlineSwap: function () {
			return false;
		},
		handleSwap: function (style, target, fragment) {
			if (style !== 'morph') {
				return false;
			}
			morphChildren(target, fragment);
			return Array.prototype.slice.call(target.childNodes);
		},
	});


	// --- small helpers ---

	function all(selector, root) {
		return Array.prototype.slice.call((root || document).querySelectorAll(selector));
	}

	function load(key, fallback) {
		try {
			var value = localStorage.getItem(key);
			return value === null ? fallback : value;
		} catch (error) {
			return fallback;
		}
	}

	function save(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch (error) {
			// the choice still works until the page is closed
		}
	}

	/** True while the user types in a field, so the page keys do not get in the way. */
	function typing(target) {
		return target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.nodeName));
	}

	/** True when a row is not drawn: filtered out by the script or hidden by a filter chip. */
	function isHidden(row) {
		return row.hidden || row.offsetParent === null;
	}

	// --- live updates ---

	var PAGES = ['overview', 'crawlers', 'proxies', 'traffic', 'insights'];
	var LABELS = { overview: 'Overview', crawlers: 'Crawlers', proxies: 'Proxies', traffic: 'Traffic', insights: 'Insights' };

	function page() {
		return document.body.getAttribute('data-page');
	}

	function loadInsights() {
		htmx.ajax('GET', '/fragments/insights', { target: '#insights', swap: 'morph' });
	}

	// Many events in a short time give one refresh, at most one a second
	var refreshPending = false;
	var lastRefresh = 0;

	function refreshNow() {
		htmx.ajax('GET', '/fragments/status', { target: '#status', swap: 'morph' });
		// the pages outside of the status block follow the live updates only while they are open
		if (page() === 'insights') {
			loadInsights();
		}
		if (page() === 'proxies') {
			htmx.ajax('GET', '/fragments/proxy-list', { target: '#proxy-list', swap: 'morph' });
		}
		var detail = document.querySelector('#detail [data-detail]');
		if (detail) {
			htmx.ajax('GET', '/fragments/crawler-detail?name=' + encodeURIComponent(detail.getAttribute('data-detail')), { target: '#detail', swap: 'morph' });
		}
	}

	function refreshStatus() {
		if (refreshPending) {
			return;
		}
		refreshPending = true;
		setTimeout(function () {
			refreshPending = false;
			lastRefresh = Date.now();
			refreshNow();
		}, Math.max(200, 1000 - (Date.now() - lastRefresh)));
	}

	function appendLog(event) {
		var data = JSON.parse(event.data);
		var view = document.getElementById('log-view');
		if (!view || view.getAttribute('data-source') !== data.source) {
			return;
		}
		var follow = document.querySelector('[data-log-follow]');
		var text = view.textContent + data.text;
		view.textContent = text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
		if (!follow || follow.checked) {
			view.scrollTop = view.scrollHeight;
		}
	}

	// Scrolling up in the log stops the follow, scrolling to the end starts it again
	document.addEventListener('scroll', function (event) {
		var view = event.target;
		var follow = document.querySelector('[data-log-follow]');
		if (view && view.id === 'log-view' && follow) {
			follow.checked = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
		}
	}, true);

	function setConnection(state, text) {
		connection.setAttribute('data-state', state);
		connectionText.textContent = text;
	}

	var source = new EventSource('/events');
	source.addEventListener('status', refreshStatus);
	source.addEventListener('log', appendLog);
	source.onopen = function () {
		setConnection('live', 'live');
		refreshStatus();
	};
	source.onerror = function () {
		setConnection('reconnecting', 'reconnecting...');
	};

	// --- pages: the hash of the URL says which one is open ---

	function showPage(name) {
		if (PAGES.indexOf(name) < 0) {
			name = 'overview';
		}
		var changed = page() !== name;
		document.body.setAttribute('data-page', name);
		all('[data-tab]').forEach(function (tab) {
			if (tab.getAttribute('data-tab') === name) {
				tab.setAttribute('aria-current', 'page');
			} else {
				tab.removeAttribute('aria-current');
			}
		});
		document.title = LABELS[name] + ' - Band Spider admin';
		if (name === 'insights') {
			loadInsights();
		}
		if (name === 'proxies' && changed && document.querySelector('#proxy-list .controlbar')) {
			htmx.ajax('GET', '/fragments/proxy-list', { target: '#proxy-list', swap: 'morph' });
		}
		if (changed) {
			window.scrollTo(0, 0);
		}
	}

	function pageOfHash() {
		return location.hash.replace('#', '').split('/')[0];
	}

	document.body.setAttribute('data-page', '');
	showPage(pageOfHash());
	window.addEventListener('hashchange', function () {
		showPage(pageOfHash());
	});

	function goTo(name) {
		if (pageOfHash() === name) {
			showPage(name);
		} else {
			location.hash = '#' + name;
		}
	}

	// --- the theme: auto (the system), light or dark ---

	var THEME_KEY = 'band-spider:theme';
	var THEMES = ['auto', 'light', 'dark'];
	var THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };

	function showTheme(theme) {
		var toggle = document.getElementById('theme-toggle');
		if (theme === 'auto') {
			document.documentElement.removeAttribute('data-theme');
		} else {
			document.documentElement.setAttribute('data-theme', theme);
		}
		toggle.setAttribute('title', 'Theme: ' + theme);
		toggle.setAttribute('aria-label', 'Theme: ' + theme + '. Click to change');
		toggle.querySelector('use').setAttribute('href', '#i-' + THEME_ICON[theme]);
	}

	var theme = load(THEME_KEY, 'auto');
	showTheme(THEMES.indexOf(theme) < 0 ? 'auto' : theme);

	// --- the chart of the overview: the chosen metric stays in the browser ---

	var CHART_KEY = 'band-spider:chart';
	var CHARTS = ['speed', 'links', 'traffic', 'errors'];
	var chart = load(CHART_KEY, 'speed');
	document.body.setAttribute('data-chart', CHARTS.indexOf(chart) < 0 ? 'speed' : chart);

	function applyChart() {
		var chosen = document.body.getAttribute('data-chart');
		all('[data-chart-pick]').forEach(function (button) {
			button.setAttribute('aria-pressed', String(button.getAttribute('data-chart-pick') === chosen));
		});
	}

	// --- the badges of the menu come from the status block ---

	function applyNav() {
		var summary = document.querySelector('[data-nav-summary]');
		if (!summary) {
			return;
		}
		var attention = Number(summary.getAttribute('data-attention'));
		var badge = document.querySelector('[data-badge="attention"]');
		badge.hidden = attention === 0;
		badge.textContent = String(attention);
		badge.setAttribute('title', attention + ' need attention');
		var crawlers = document.querySelector('[data-badge="crawlers"]');
		var total = Number(summary.getAttribute('data-total'));
		crawlers.hidden = total === 0;
		crawlers.textContent = summary.getAttribute('data-running') + '/' + total;
		crawlers.setAttribute('title', summary.getAttribute('data-running') + ' of ' + total + ' running');
		crawlers.setAttribute('data-tone', Number(summary.getAttribute('data-failed')) > 0 ? 'bad' : 'ok');
	}

	// --- the plan of the traffic page: the limit stays in the browser ---

	var PLAN_KEY = 'band-spider:plan-gb';

	function applyPlan() {
		var box = document.querySelector('[data-plan]');
		if (!box) {
			return;
		}
		var input = box.querySelector('[data-plan-input]');
		var plan = load(PLAN_KEY, '');
		if (document.activeElement !== input && input.value !== plan) {
			input.value = plan;
		}
		var text = box.querySelector('[data-plan-text]');
		var bar = box.querySelector('[data-plan-bar]');
		var limit = Number(plan);
		if (!plan || !(limit > 0)) {
			text.textContent = 'Enter the plan to compare';
			bar.setAttribute('width', '0');
			box.removeAttribute('data-level');
			return;
		}
		var percent = Number(box.getAttribute('data-month-bytes')) / (limit * 1e9) * 100;
		text.textContent = '~' + Math.round(percent) + '% of the plan at this speed';
		bar.setAttribute('width', String(Math.min(percent, 100).toFixed(1)));
		box.setAttribute('data-level', percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : 'ok');
	}

	document.body.addEventListener('input', function (event) {
		if (event.target.hasAttribute && event.target.hasAttribute('data-plan-input')) {
			save(PLAN_KEY, event.target.value.trim());
			applyPlan();
		}
	});

	// --- crawler table: filter and sort ---

	// The server sends the rows in the order of the config with data-* values. The choice lives here, so a live update
	// (which puts the rows back in the order of the config) cannot lose it.
	var TOOLS_KEY = 'band-spider:crawler-tools';
	var NUMERIC = { index: 1, requests: 1, urls: 1, http429: 1, saved: 1, bytes: 1, links: 1 };
	var ACTIVE = { starting: 1, running: 1, stopping: 1 };
	var DEFAULT_TOOLS = { search: '', state: '', type: '', sort: 'index', desc: false };
	var tools = JSON.parse(JSON.stringify(DEFAULT_TOOLS));

	try {
		var storedTools = JSON.parse(load(TOOLS_KEY, 'null'));
		if (storedTools && typeof storedTools === 'object') {
			Object.keys(tools).forEach(function (key) {
				if (typeof storedTools[key] === typeof tools[key]) {
					tools[key] = storedTools[key];
				}
			});
		}
	} catch (error) {
		// a broken value: the defaults are used
	}

	function saveTools() {
		save(TOOLS_KEY, JSON.stringify(tools));
	}

	function resetTools() {
		tools = JSON.parse(JSON.stringify(DEFAULT_TOOLS));
	}

	function compareRows(a, b) {
		var key = tools.sort;
		var left = a.dataset[key];
		var right = b.dataset[key];
		var order = NUMERIC[key] ? Number(left) - Number(right) : String(left).localeCompare(String(right), 'en', { numeric: true });
		if (order === 0 && key !== 'index') {
			order = Number(a.dataset.index) - Number(b.dataset.index);
		}
		return tools.desc ? -order : order;
	}

	function stateMatches(state) {
		return !tools.state || (tools.state === 'active' ? ACTIVE[state] === 1 : state === tools.state);
	}

	/**
	 * Applies the filter and the sort. A live update does not move the rows while the pointer is over the table,
	 * so a click does not hit a row that just moved there. The order is fixed when the pointer leaves.
	 */
	function applyTools(live) {
		var panel = document.querySelector('[data-tools]');
		var body = document.querySelector('table.crawlers tbody');
		if (!panel || !body) {
			updateBulk();
			return;
		}
		// the controls show the saved choice, also after the server drew them empty again
		all('[data-filter]', panel).forEach(function (control) {
			var wanted = tools[control.getAttribute('data-filter')];
			if (control.value !== wanted) {
				control.value = wanted;
			}
		});
		all('[data-chip]', panel).forEach(function (chip) {
			chip.setAttribute('aria-pressed', String(tools[chip.getAttribute('data-chip')] === chip.getAttribute('data-value')));
		});
		panel.querySelector('[data-sort-key]').value = tools.sort;
		panel.querySelector('[data-sort-desc]').checked = tools.desc;
		all('table.crawlers th[data-sort-col]').forEach(function (head) {
			if (head.getAttribute('data-sort-col') === tools.sort) {
				head.setAttribute('aria-sort', tools.desc ? 'descending' : 'ascending');
			} else {
				head.removeAttribute('aria-sort');
			}
		});

		var rows = Array.prototype.slice.call(body.rows);
		var term = tools.search.trim().toLowerCase();
		var shown = 0;
		rows.forEach(function (row) {
			var match = (!term || row.dataset.search.indexOf(term) >= 0)
				&& stateMatches(row.dataset.state)
				&& (!tools.type || row.dataset.type === tools.type);
			row.hidden = !match;
			if (match) {
				shown++;
			} else {
				// a crawler that the filter hides is not part of a bulk action
				var box = row.querySelector('input[name="names"]');
				if (box) {
					box.checked = false;
				}
			}
		});
		if (live !== true || !body.matches(':hover')) {
			rows.sort(compareRows).forEach(function (row, position) {
				if (body.rows[position] !== row) {
					body.insertBefore(row, body.rows[position]);
				}
			});
		}

		var counter = panel.querySelector('[data-shown]');
		counter.textContent = shown + ' of ' + counter.getAttribute('data-total') + ' shown';
		var none = document.querySelector('[data-no-match]');
		if (none) {
			none.hidden = shown !== 0;
		}
		updateBulk();
	}

	function readTool(control) {
		if (control.hasAttribute('data-filter')) {
			tools[control.getAttribute('data-filter')] = control.value;
		} else if (control.hasAttribute('data-sort-key')) {
			tools.sort = control.value;
		} else if (control.hasAttribute('data-sort-desc')) {
			tools.desc = control.checked;
		} else {
			return;
		}
		saveTools();
		applyTools();
	}

	document.body.addEventListener('input', function (event) {
		if (event.target.closest && event.target.closest('[data-tools]')) {
			readTool(event.target);
		}
	});
	document.body.addEventListener('change', function (event) {
		if (event.target.closest && event.target.closest('[data-tools]')) {
			readTool(event.target);
		}
	});

	document.body.addEventListener('mouseleave', function (event) {
		if (event.target.matches && event.target.matches('table.crawlers tbody')) {
			applyTools();
		}
	}, true);

	// --- crawler table: choose rows for a bulk action ---

	function updateBulk() {
		var boxes = all('input[name="names"]');
		var chosen = boxes.filter(function (box) {
			return box.checked;
		}).length;
		var counter = document.querySelector('[data-bulk-count]');
		counter.textContent = String(chosen);
		var pickAll = document.querySelector('[data-pick-all]');
		if (pickAll) {
			var visible = boxes.filter(function (box) {
				return !isHidden(box.closest('tr'));
			});
			var visibleChosen = visible.filter(function (box) {
				return box.checked;
			}).length;
			pickAll.checked = visible.length > 0 && visibleChosen === visible.length;
			pickAll.indeterminate = visibleChosen > 0 && visibleChosen < visible.length;
		}
	}

	function clearBulk() {
		all('input[name="names"]').forEach(function (box) {
			box.checked = false;
		});
		updateBulk();
	}

	document.body.addEventListener('change', function (event) {
		var target = event.target;
		if (target.hasAttribute && target.hasAttribute('data-pick-all')) {
			all('input[name="names"]').forEach(function (box) {
				if (!isHidden(box.closest('tr'))) {
					box.checked = target.checked;
				}
			});
			updateBulk();
		} else if (target.name === 'names') {
			updateBulk();
		}
	});

	// after a bulk action the choice is cleared, so the next click does not act on the same crawlers by mistake
	document.body.addEventListener('htmx:afterRequest', function (event) {
		var elt = event.detail && event.detail.elt;
		if (elt && elt.closest && elt.closest('#bulk-form') && event.detail.successful) {
			clearBulk();
		}
	});

	// the status block is drawn again by every live update and by the control buttons
	function afterStatus() {
		applyTools(true);
		applyChart();
		applyNav();
		applyPlan();
	}
	document.body.addEventListener('htmx:afterSwap', afterStatus);
	document.body.addEventListener('htmx:oobAfterSwap', afterStatus);

	// --- proxy list: filter and choose proxies ---

	var PROXY_FILTER_KEY = 'band-spider:proxy-filter';
	document.body.setAttribute('data-proxy-filter', load(PROXY_FILTER_KEY, ''));

	function applyProxyFilter() {
		var chosen = document.body.getAttribute('data-proxy-filter');
		all('[data-proxy-chip]').forEach(function (chip) {
			chip.setAttribute('aria-pressed', String(chip.getAttribute('data-proxy-chip') === chosen));
		});
	}

	function updateChosenCount() {
		var counter = document.querySelector('[data-selected-count]');
		if (counter) {
			counter.textContent = String(document.querySelectorAll('input[name="keys"]:checked:not(:disabled)').length);
		}
	}

	// Shift+click chooses (or clears) every shown proxy between the last clicked box and this one
	var lastPicked = null;
	document.body.addEventListener('click', function (event) {
		var box = event.target;
		if (!box || box.name !== 'keys' || box.type !== 'checkbox') {
			return;
		}
		if (event.shiftKey && lastPicked && lastPicked.isConnected) {
			var boxes = all('input[name="keys"]');
			var from = boxes.indexOf(lastPicked);
			var to = boxes.indexOf(box);
			boxes.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(function (item) {
				if (!item.disabled && !isHidden(item.closest('tr'))) {
					item.checked = box.checked;
				}
			});
			updateChosenCount();
		}
		lastPicked = box;
	});
	document.body.addEventListener('change', function (event) {
		if (event.target.name === 'keys') {
			updateChosenCount();
		}
	});
	document.body.addEventListener('htmx:afterSwap', function () {
		updateChosenCount();
		applyProxyFilter();
	});
	// after the crawlers are created the choice is done, so every box is cleared
	document.body.addEventListener('htmx:afterRequest', function (event) {
		if (event.detail.successful && event.detail.elt && event.detail.elt.id === 'chosen-form') {
			all('input[name="keys"]').forEach(function (box) {
				box.checked = false;
			});
			updateChosenCount();
		}
	});

	// --- clicks ---

	document.body.addEventListener('click', function (event) {
		var target = event.target;
		if (!target || !target.closest) {
			return;
		}

		// a message is closed by its button
		var close = target.closest('.toast-close');
		if (close) {
			close.parentNode.remove();
		}

		// a click on the dark area around the form closes it
		if (target.classList.contains('modal')) {
			var cancel = target.querySelector('[data-close]');
			if (cancel) {
				cancel.click();
			}
		}

		// a menu closes after a choice and when the click is outside of it
		all('details.menu[open]').forEach(function (menu) {
			if (!menu.contains(target) || target.closest('.menu-list button') || target.closest('.menu-list a')) {
				menu.removeAttribute('open');
			}
		});

		var pick = target.closest('[data-chart-pick]');
		if (pick) {
			document.body.setAttribute('data-chart', pick.getAttribute('data-chart-pick'));
			save(CHART_KEY, pick.getAttribute('data-chart-pick'));
			applyChart();
		}

		var chip = target.closest('[data-chip]');
		if (chip) {
			tools[chip.getAttribute('data-chip')] = chip.getAttribute('data-value');
			saveTools();
			applyTools();
		}

		var sort = target.closest('[data-sort]');
		if (sort) {
			var key = sort.getAttribute('data-sort');
			// a second click turns the order around, numbers start with the biggest
			tools.desc = tools.sort === key ? !tools.desc : NUMERIC[key] === 1;
			tools.sort = key;
			saveTools();
			applyTools();
		}

		if (target.closest('[data-tools-reset]')) {
			resetTools();
			saveTools();
			applyTools();
		}

		// the states of the overview open the table with that filter
		var gotoState = target.closest('[data-goto-state]');
		var gotoType = target.closest('[data-goto-type]');
		if (gotoState || gotoType) {
			resetTools();
			if (gotoState) {
				tools.state = gotoState.getAttribute('data-goto-state');
			} else {
				tools.type = gotoType.getAttribute('data-goto-type');
			}
			saveTools();
			applyTools();
			goTo('crawlers');
		}

		var proxyChip = target.closest('[data-proxy-chip]');
		if (proxyChip) {
			document.body.setAttribute('data-proxy-filter', proxyChip.getAttribute('data-proxy-chip'));
			save(PROXY_FILTER_KEY, proxyChip.getAttribute('data-proxy-chip'));
			applyProxyFilter();
		}

		var select = target.closest('[data-select]');
		if (select) {
			// "all" chooses every shown proxy, "free" only the shown proxies without a crawler, "none" clears
			var mode = select.getAttribute('data-select');
			all('input[name="keys"]').forEach(function (box) {
				var wanted = mode === 'all' || (mode === 'free' && box.hasAttribute('data-free'));
				box.checked = wanted && !isHidden(box.closest('tr'));
			});
			updateChosenCount();
		}

		if (target.closest('[data-bulk-clear]')) {
			clearBulk();
		}

		var opener = target.closest('[data-open-dialog]');
		if (opener) {
			var dialog = document.getElementById(opener.getAttribute('data-open-dialog'));
			if (dialog && !dialog.open) {
				dialog.showModal();
			}
		}

		var dialogClose = target.closest('[data-dialog-close]');
		if (dialogClose && dialogClose.closest('dialog')) {
			dialogClose.closest('dialog').close();
		}
		// a click on the dark area around a dialog closes it
		if (target.nodeName === 'DIALOG' && target.id !== 'confirm-dialog') {
			target.close();
		}

		if (target.closest('#theme-toggle')) {
			var current = document.documentElement.getAttribute('data-theme') || 'auto';
			var next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
			save(THEME_KEY, next);
			showTheme(next);
		}
	});

	// --- keys: Escape closes the top layer, 1-5 open a page, / searches the crawlers ---

	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape') {
			var menu = document.querySelector('details.menu[open]');
			if (menu) {
				menu.removeAttribute('open');
				return;
			}
			var closer = document.querySelector('#form-area [data-close]') || document.querySelector('#logs [data-close]')
				|| document.querySelector('#detail [data-close]');
			if (closer) {
				closer.click();
			}
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || document.querySelector('dialog[open]')) {
			return;
		}
		var number = Number(event.key);
		if (number >= 1 && number <= PAGES.length) {
			goTo(PAGES[number - 1]);
		} else if (event.key === '/') {
			event.preventDefault();
			goTo('crawlers');
			var search = document.querySelector('[data-tools] [data-filter="search"]');
			if (search) {
				search.focus();
			}
		}
	});

	// --- messages: the ones with a time go away alone ---

	new MutationObserver(function (records) {
		records.forEach(function (record) {
			Array.prototype.forEach.call(record.addedNodes, function (node) {
				var ttl = node.nodeType === 1 && node.getAttribute('data-ttl');
				if (ttl) {
					setTimeout(function () {
						node.remove();
					}, Number(ttl));
				}
			});
		});
	}).observe(document.getElementById('toasts'), { childList: true });

	// --- a confirmation dialog of the page instead of the one of the browser ---

	document.body.addEventListener('htmx:confirm', function (event) {
		if (!event.detail.question) {
			return;
		}
		event.preventDefault();
		var dialog = document.getElementById('confirm-dialog');
		document.getElementById('confirm-text').textContent = event.detail.question;
		dialog.returnValue = '';
		dialog.addEventListener('close', function onClose() {
			dialog.removeEventListener('close', onClose);
			if (dialog.returnValue === 'ok') {
				event.detail.issueRequest(true);
			}
		});
		dialog.showModal();
	});

	// --- proxy file ---

	// A chosen proxy file is read in the browser and put in the text box, so no upload is needed
	document.body.addEventListener('change', function (event) {
		var target = event.target;
		if (!target || target.id !== 'proxy-file' || !target.files || !target.files[0]) {
			return;
		}
		var reader = new FileReader();
		reader.onload = function () {
			var box = document.getElementById('proxy-text');
			if (box) {
				box.value = String(reader.result);
			}
		};
		reader.readAsText(target.files[0]);
	});

	// --- drawers: the end of the log and the focus ---

	var detailWasOpen = false;
	document.body.addEventListener('htmx:beforeSwap', function (event) {
		var target = event.detail && event.detail.target;
		if (target && target.id === 'detail') {
			detailWasOpen = target.children.length > 0;
		}
	});

	// Show the end of the log only when the log is opened. A live update of the status must not move it.
	document.body.addEventListener('htmx:afterSwap', function (event) {
		var target = event.detail && event.detail.target;
		if (!target) {
			return;
		}
		var view = document.getElementById('log-view');
		if (view && target.id === 'logs') {
			view.scrollTop = view.scrollHeight;
		}
		// a drawer that just opened gets the focus, so Tab and Escape work in it
		var opened = (target.id === 'logs' || target.id === 'form-area' || (target.id === 'detail' && !detailWasOpen));
		var focus = opened && target.querySelector('[autofocus], [data-close]');
		if (focus) {
			focus.focus();
		}
	});

	afterStatus();
	applyProxyFilter();
})();
