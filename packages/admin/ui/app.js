// Live updates: the server says "status" when something changed and sends new log text.
(function () {
	var MAX_LOG_CHARS = 200000;
	var connection = document.getElementById('connection');
	var connectionText = document.getElementById('connection-text');
	var timer;

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
		var keyed = {};
		Array.prototype.forEach.call(from.childNodes, function (node) {
			var key = keyOf(node);
			if (key) {
				keyed[key] = node;
			}
		});
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

	// --- live updates ---

	// Many events in a short time give one refresh of the status block
	function refreshStatus() {
		clearTimeout(timer);
		timer = setTimeout(function () {
			htmx.ajax('GET', '/fragments/status', { target: '#status', swap: 'morph' });
			// an open Insights view follows the live updates too
			if (document.querySelector('#insights .insights')) {
				htmx.ajax('GET', '/fragments/insights', { target: '#insights', swap: 'morph' });
			}
		}, 200);
	}

	function appendLog(event) {
		var data = JSON.parse(event.data);
		var view = document.getElementById('log-view');
		if (!view || view.getAttribute('data-source') !== data.source) {
			return;
		}
		var atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
		var text = view.textContent + data.text;
		view.textContent = text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
		if (atEnd) {
			view.scrollTop = view.scrollHeight;
		}
	}

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

	// --- pages ---

	function showTab(name) {
		Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (tab) {
			tab.setAttribute('aria-selected', String(tab.getAttribute('data-tab') === name));
		});
		Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (view) {
			view.hidden = view.getAttribute('data-view') !== name;
		});
	}

	var initial = location.hash.replace('#', '');
	showTab(initial === 'proxies' ? 'proxies' : 'overview');

	document.body.addEventListener('click', function (event) {
		var target = event.target;
		if (!target || !target.closest) {
			return;
		}
		var tab = target.closest('[data-tab]');
		if (tab) {
			showTab(tab.getAttribute('data-tab'));
			history.replaceState(null, '', '#' + tab.getAttribute('data-tab'));
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
		Array.prototype.forEach.call(document.querySelectorAll('details.menu[open]'), function (menu) {
			if (!menu.contains(target) || target.closest('.menu-list button')) {
				menu.removeAttribute('open');
			}
		});
	});

	document.addEventListener('keydown', function (event) {
		if (event.key !== 'Escape') {
			return;
		}
		var closer = document.querySelector('#form-area [data-close]') || document.querySelector('#insights [data-close]')
			|| document.querySelector('#logs [data-close]');
		if (closer) {
			closer.click();
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

	// Show the end of the log only when the log is opened. A live update of the status must not move it.
	document.body.addEventListener('htmx:afterSwap', function (event) {
		var target = event.detail && event.detail.target;
		var view = document.getElementById('log-view');
		if (view && target && target.id === 'logs') {
			view.scrollTop = view.scrollHeight;
		}
	});
})();
