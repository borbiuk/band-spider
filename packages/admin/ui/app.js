// Live updates: the server says "status" when something changed and sends new log text.
(function () {
	var MAX_LOG_CHARS = 200000;
	var connection = document.getElementById('connection');
	var timer;

	// Many events in a short time give one refresh of the status block
	function refreshStatus() {
		clearTimeout(timer);
		timer = setTimeout(function () {
			htmx.ajax('GET', '/fragments/status', { target: '#status', swap: 'innerHTML' });
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

	var source = new EventSource('/events');
	source.addEventListener('status', refreshStatus);
	source.addEventListener('log', appendLog);
	source.onopen = function () {
		connection.textContent = 'live';
		refreshStatus();
	};
	source.onerror = function () {
		connection.textContent = 'reconnecting...';
	};

	// Show the end of the log when it is opened
	document.body.addEventListener('htmx:afterSwap', function () {
		var view = document.getElementById('log-view');
		if (view) {
			view.scrollTop = view.scrollHeight;
		}
	});
})();
