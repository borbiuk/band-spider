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

const delay = (time) => {
	return new Promise(function(resolve) {
		setTimeout(resolve, time)
	});
}

module.exports = {
	chunkArray,
	delay,
	onlyUnique,
}
