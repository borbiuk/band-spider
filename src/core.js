const puppeteer = require('puppeteer');
const {log} = require('./log');
const {delay} = require("./utils");

// Click the "Load More" button until all values are loaded
const loadAllAccounts = async (page) => {
	let loadMoreButton;
	let retry = 0;
	while (retry < 3) {
		if (retry !== 0) {
			await delay(2_000);
		}

		loadMoreButton = await page.$('.more-thumbs');
		if (!loadMoreButton) {
			retry++;
			continue;
		}

		try {
			await loadMoreButton.click();
			log(`"Load more..." button clicked: ${page.url()}`);
		} catch {
			retry++;
		}
	}
};

// Scrape hrefs from <a class="fan pic"></a> elements
const getAccounts = async (page) => {
	const hrefs = [];

	const fanPics = await page.$$('a.fan.pic');
	for (const fanPic of fanPics) {
		const href = await fanPic.getProperty('href');
		const hrefValue = await href.jsonValue();
		hrefs.push(hrefValue.split('?')[0]);
	}

	return hrefs;
}

const scrapeAlbumOrTrackAccounts = async (trackOrAlbumUrl) => {
	const browser = await puppeteer.launch();
	const page = await browser.newPage();
	await page.goto(trackOrAlbumUrl);

	log('Album opened: ' + page.url());

	await loadAllAccounts(page);
	const accountUrls = await getAccounts(page);

	await browser.close();

	log('Albums founded: ' + page.url(), accountUrls);
	return accountUrls;
};

module.exports = {
	scrapeAlbumOrTrackAccounts,
};
