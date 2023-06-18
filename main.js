const {accountScraper} = require("./src/core/account-scraper");
const {tracksScraper} = require("./src/core/tracks-scraper");

const main = async () => {
	console.time('main');

	//await accountScraper();
	await tracksScraper();

	console.timeEnd('main');
};

process.setMaxListeners(0); // Set maximum listeners to unlimited

main();

