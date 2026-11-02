// Sets the theme the user chose (light or dark) before the page is drawn. Without a choice the system theme is used.
(function () {
	try {
		var theme = localStorage.getItem('band-spider:theme');
		if (theme === 'light' || theme === 'dark') {
			document.documentElement.setAttribute('data-theme', theme);
		}
	} catch (error) {
		// no storage: the system theme is used
	}
})();
