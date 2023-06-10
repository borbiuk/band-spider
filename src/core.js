const puppeteer = require('puppeteer');
const {log} = require("./log");

// Click the "Load More" button until all values are loaded
const loadAllAlbumBuyers = async (page) => {
	let loadMoreButton;
	while (true) {
		loadMoreButton = await page.$('.more-thumbs');
		if (!loadMoreButton) {
			break;
		}

		try {
			await loadMoreButton.click();
			log('button clicked: ' + page.url());
			await page.waitForTimeout(3_000); // Adjust the timeout as needed
		} catch {
			break;
		}
	}
};

// Scrape hrefs from <a class="fan pic"></a> elements
const getAllAlbumBuyers = async (page) => {
	const hrefs = [];

	const fanPics = await page.$$('a.fan.pic');
	for (const fanPic of fanPics) {
		const href = await fanPic.getProperty('href');
		const hrefValue = await href.jsonValue();
		hrefs.push(hrefValue.split('?')[0]);
	}

	return hrefs;
}

const scrapePage = async (albumUrl) => {
	const browser = await puppeteer.launch();
	const page = await browser.newPage();
	await page.goto(albumUrl);

	log('Album opened: ' + page.url());

	await loadAllAlbumBuyers(page);
	const hrefs = await getAllAlbumBuyers(page);

	await browser.close();

	log('Albums founded: ' + page.url() + '\n' + JSON.stringify(hrefs));
	return hrefs;
};

module.exports = {
	scrapePage,
};
