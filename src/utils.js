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

module.exports = {
	onlyUnique,
	chunkArray
}
