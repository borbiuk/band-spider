const onlyUnique = (value, index, array) => {
	return array.indexOf(value) === index;
}

const chunkArray = (array, chunkSize) => {
	const chunks = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
};

const createChunks = (array, chunkCount) => {
	const length = array.length;
	const chunkSize = Math.ceil(length / chunkCount);
	const chunks = [];

	for (let i = 0; i < length; i += chunkSize) {
		const chunk = array.slice(i, i + chunkSize);
		chunks.push(chunk);
	}

	return chunks;
}

const delay = (time) => {
	return new Promise(function (resolve) {
		setTimeout(resolve, time)
	});
}

const isAlbum = (url) => url.includes('/album/');
const isTrack = (url) => url.includes('/track/');
const originalUrl = (url) => url.split('?')[0];

module.exports = {
	chunkArray,
	createChunks,
	delay,
	onlyUnique,
	isAlbum,
	isTrack,
	originalUrl
}
