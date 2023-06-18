export const onlyUnique = (value, index, array) => {
	return array.indexOf(value) === index;
}

export const chunkArray = (array, chunkSize) => {
	const chunks = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
};

export const createChunks = (array, chunkCount) => {
	const length = array.length;
	const chunkSize = Math.ceil(length / chunkCount);
	const chunks = [];

	for (let i = 0; i < length; i += chunkSize) {
		const chunk = array.slice(i, i + chunkSize);
		chunks.push(chunk);
	}

	return chunks;
}

export const delay = (time) => {
	return new Promise(function (resolve) {
		setTimeout(resolve, time)
	});
}

export const isAlbum = (url) => url.includes('/album/');
export const isTrack = (url) => url.includes('/track/');
export const originalUrl = (url) => url.split('?')[0];
