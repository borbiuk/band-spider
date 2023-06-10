const {accountScraper} = require("./src/core/account-scraper");

const main = async () => {
	console.time('main');

	await accountScraper();

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

