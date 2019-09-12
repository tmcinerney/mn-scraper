// Imports
const spawn = require("child_process").spawn;

module.exports = {
	collect(value, previous) {
		return previous.concat([value]);
	},
	createDirs(dirs) {
		return new Promise((resolve, reject) => {
			let child = spawn("mkdir", ["-p", dirs]);
			child.on("exit", (code) => {
				if (code == 0)
					resolve();
				else
					reject();
			});
		});
	}
}