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

const isAlbum = (url) => url.includes('/album/');
const isTrack = (url) => url.includes('/track/');

const delay = (time) => {
	return new Promise(function(resolve) {
		setTimeout(resolve, time)
	});
}

module.exports = {
	onlyUnique,
	chunkArray,
	isAlbum,
	isTrack,
	delay,
}
