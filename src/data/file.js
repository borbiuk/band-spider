const fs = require('fs');
const utils = require("../common/utils");

const readUrlsFromFile = (filename) => {
	const fileContent = fs.readFileSync(filename, 'utf8');
	return fileContent.split('\n')
		.filter(Boolean)
		.filter((value, index, array) => utils.onlyUnique(value, index, array));
};

module.exports = {
	readUrlsFromFile,
};
