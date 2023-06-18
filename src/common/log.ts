export const log = (...params) => {
	let message = '';

	for (let param of params) {
		if (Array.isArray(param)) {
			message += `(${param.length}) [\n`
			param.forEach(x => {
				message += `\t${x}\n`
			});
			message += ']\n'
		}
		else if (typeof param === 'object') {
			message += `${JSON.stringify(param)}\n`;
		}
		else {
			message += param + '\n';
		}
	}

	console.log('%cINFO: %c' + message, 'background: #202124; color: #1BA0C3', 'background: #202124; color: white');
}
