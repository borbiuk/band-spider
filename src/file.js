const fs = require('fs');
const {onlyUnique} = require("./utils");

const readUrlsFromFile = (filename) => {
	const fileContent = fs.readFileSync(filename, 'utf8');
	return fileContent.split('\n')
		.filter(Boolean)
		.filter(onlyUnique);
};

module.exports = {
	readUrlsFromFile,
};
