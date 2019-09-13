// Imports
const fs = require("fs");
const path = require("path");
const program = require("commander");

// Modules
const mumsnet = require("./mumsnet/lib");
const utils = require("./utils");

// Concurrent promises
const concurrency = 5;
const limit = require("p-limit")(concurrency);

// Templates
const templatesDir = path.join(__dirname, "templates");
let wrapperTemplate;
let threadTemplate;
let postTemplate;


// Arguments
program
	.option("-e <email>", "The email address of the account")
	.option("-p <password>", "The password of the account")
	.option("-t <token>", "A valid session token")
	.option("-f <format>", "The output format (json|html)")
	.option("-q <query>", "The string to match")
	.option("-o <dir>", "The output directory")
	.option("-n <num>", "The number of threads to parse")
	.option("-c", "Include number of comments in filenames")
	.option("-a <id>", "A chosen topic ID to narrow down the search", utils.collect, [])
	.option("--from <date>", "The start date");

// Default options
let options = {
	format: "html", // ["html", "json"]
	dir: "/output",	// The default output dir
	includeComments: false
};

function generateHTML(thread, query, dir) {
	let postsHTML = thread.posts.map((post, i) => {
		return postTemplate
			.replace("{{post_index}}", i)
			.replace("{{author}}", post.author)
			.replace("{{date}}", post.date)
			.replace("{{content}}", post.text.replace("\n", "<br><br>"))
			.replace(query, `<b>${query}</b>`);
	}).join("");

	let threadHTML = threadTemplate.replace("{{title}}", thread.info.title).replace("{{posts}}", postsHTML).replace("{{thread_url}}", "https://www.mumsnet.com/" + thread.info.url);
	let wrapperHTML = wrapperTemplate.replace("{{title}}", thread.info.title).replace("{{content}}", threadHTML).replace("{{css_link}}", path.relative(dir, path.join(templatesDir, "styles.css")));
	return wrapperHTML;
}

async function writeSplitOutput(threads, query, format, outputDir, includeComments) {
	await Promise.all(threads.map((thread) => limit(async () => {
		// Create dirs
		let dir = path.join(outputDir, query);
		await utils.createDirs(dir);

		// Generate output
		let output = format == "json" ? JSON.stringify(thread) : generateHTML(thread, query, dir);

		// Write the file
		await fs.promises.writeFile(path.join(dir, `${thread.info.id}${includeComments ? `_${thread.posts.length}` : ""}.${format}`), output);
	})));
}

async function init() {
	// Load HTML templates
	wrapperTemplate = (await fs.promises.readFile(path.join(templatesDir, "wrapper.html"))).toString("utf-8");
	threadTemplate = (await fs.promises.readFile(path.join(templatesDir, "thread.html"))).toString("utf-8");
	postTemplate = (await fs.promises.readFile(path.join(templatesDir, "post.html"))).toString("utf-8");

	// Parse arguments
	program.parse(process.argv);
	let parsed = program.opts();

	// We either need both email and password or a token.
	if (!((parsed.E && parsed.P) || parsed.T))
		return console.log("Need an authentication method.");

	if (parsed.F && parsed.F != "json" && parsed.F != "html")
		return console.log("Invalid output format specified.");

	if (!parsed.Q)
		return console.log("No search query specified.");

	if (parsed.N)
		options.num = parseInt(parsed.N);

	options.email = parsed.E;
	options.password = parsed.P;
	options.token = parsed.T;
	options.format = parsed.F ? parsed.F : options.format;
	options.query = parsed.Q;
	options.dir = parsed.O ? parsed.O : path.join(__dirname, options.dir);
	options.includeComments = parsed.C;
	options.topics = parsed.A;
	options.from = parsed.from;

	// Perform authentication
	// TODO: Check session token before usage.
	if (options.token)
		mumsnet.setSessionToken(options.token);
	else if (options.email && options.password && !(await mumsnet.authenticate(options.email, options.password))) {
		return console.log("Authentication failed.");
	} else
		console.log(`Authentication successful. Session token: "${mumsnet.getSessionToken()}".`);

	// Perform search
	let threads = await mumsnet.search(options.query, options.topics, options.from);
	console.log(`Found ${threads.length} thread${threads.length == 1 ? "" : "s"}.`);
	if (threads.length == 0)
		return;

	// Scrape the threads
	let scrapedThreads = await mumsnet.scrapeThreads(options.num && !isNaN(options.num) && options.num < threads.length ? threads.splice(0, options.num) : threads);
	await writeSplitOutput(scrapedThreads, options.query, options.format, options.dir, options.includeComments);
	console.log(`${scrapedThreads.length} thread${scrapedThreads.length == 1 ? "" : "s"} written to "${options.dir}".\nDone.`);
}

init();