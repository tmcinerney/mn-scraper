// Imports
const request = require("request");
const cheerio = require("cheerio");
const progress = require("cli-progress");

// Consts
const baseURL = "https://www.mumsnet.com";
const concurrency = 20;
const limit = require("p-limit")(concurrency);

// Vars
var authenticated = false;
var sessionToken = null;

async function progressWrap(thread, p, i, bar) {
	let posts = await p;
	bar.update(i + 1);
	return {
		thread,
		posts
	};
}

module.exports = {
	authenticate(email, password) {
		return new Promise((resolve) => {
			request.post("https://www.mumsnet.com/ajax/session/login", {
				headers: {
					"sec-fetch-mode": "cors",
					"origin": "https://www.mumsnet.com",
					"accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
					"x-requested-with": "XMLHttpRequest",
					"pragma": "no-cache",
					"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36",
					"content-type": "application/x-www-form-urlencoded;",
					"accept": "application/json, text/javascript, */*; q=0.01",
					"cache-control": "no-cache",
					"authority": "www.mumsnet.com",
					"referer": "https://www.mumsnet.com/session/login-user?target=%2F",
					"sec-fetch-site": "same-origin"
				},
				body: `login=login&username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
			}, (err, response, body) => {
				// Return if there was an error while requesting.
				if (err)
					return resolve(false);

				// Parse JSON
				var payload;
				try { payload = JSON.parse(body); }
				catch (e) {
					return resolve(false);
				}

				// Return if login failed.
				if (!payload.succeeded || !Array.isArray(response.headers["set-cookie"]))
					return resolve(false);

				// Parse session token
				let cookies = response.headers["set-cookie"].filter(cookie => cookie.substr(0, 9) == "rootsess=");
				if (cookies.length == 0)
					return resolve(false);

				authenticated = true;
				sessionToken = cookies[0].split("=")[1].split(";")[0];
				return resolve(true);
			});
		})
	},
	request(url, method) {
		return new Promise(resolve => {
			if (!authenticated)
				return resolve(false);

			request(baseURL + url, {
				method: method,
				headers: {
					cookie: `rootsess=${sessionToken}`
				}
			}, (err, response, body) => {
				if (err)
					return resolve(null);

				return resolve(body);
			});
		});
	},
	async search(mustMatch = "", topics = [], from = "", to="") {
		let topicsString = topics.reduce((previous, current) => previous += `&chosentops=${current}`, "");
		let searchOption = 's_t_d_t';
		let pathAndQueryString = `/SearchArch?mustmatch=${encodeURIComponent(mustMatch)}&dontmatch=&nickname=&src_displ_option=${encodeURIComponent(searchOption)}&fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}&topicmode=${topics.length == 0 ? "All" : "chs"}${topicsString}`;
		let result = await this.request(pathAndQueryString, "GET");
		if (!result)
			return false;

		// Parse HTML
		let $ = cheerio.load(result);
		let results = [];
		$(".result_details").map((i, element) => {
			// Parse link and the ID of the thread
			let link = $(element).children(".title_link").attr("href");
			let linkParts = link.split("/");
			let id = linkParts[linkParts.length - 1].split("-")[0];

			// Get the title
			let title = $(element).children(".title_link").text().trim();
			let author = $(element).children(".item_details").children(".nickname").text().trim();
			results.push({
				id,
				url: link,
				index: i,
				title,
				author
			});
		});

		return results;
	},
	// NOTE: A `message` size of `1` essentially means there will be more pages to render.
	//       i.e. 30 pages with 1 post, instead of 1 page with 30 posts.
	async scrapeThread(thread, messages = 100, page = 1) {
		let result = await this.request(`/${thread.url}?pg=${page}&messages=${messages}`, "GET");
		if (!result)
			return false;

		// Parse HTML
		let $ = cheerio.load(result);

		// Parse posts
		let posts = [];
		$("#posts").children(".post").map((index, element) => {
			// Skip first post if the page isn't the first
			if (page != 1 && index == 0)
				return;

			let id = $(element).attr("id");
			let author = $(element).children(".bar").children(".nickname").children(".nick").text().trim();
			let date = $(element).children(".bar").children(".post_time").text().trim();
			let message = $(element).children(".message").children("p").first();
			
			// Correct the emojis
			let images = message.children("img");
			images.map((i, img) => {
				images.replaceWith(`[${img.attribs.alt ? img.attribs.alt : "image"}]`);
			});

			// Replace line breaks with newlines
			message.children("br").replaceWith("\n");
			posts.push({
				id,
				author,
				date,
				text: message.text()
			});
		});

		// Parse page numbers and get the next page's posts if necessary
		try {
			let pagesText = $(".thread_links > .message_pages > .pages > p").first().text();
			let numPages = parseInt(pagesText.split("of ")[1].split(" ")[0]);
			if (page < numPages)
				posts = posts.concat(await this.scrapeThread(thread, messages, page + 1));
		} catch (e) {
			return [];
		}
		
		return posts;
	},
	async scrapeThreads(threads) {
		// Get start date and log
		let start = new Date();
		console.log(`Scraping ${threads.length} thread${threads.length == 1 ? "" : "s"}...`);

		// Create progress bar
		let bar = new progress.Bar({}, progress.Presets.rect);
		bar.start(threads.length, 0);

		// Result array
		/*let results = [];

		// Sequential promise fuckery
		
		let last = await threads.map((thread, i) => {
			return () => progressWrap(thread, () => this.scrapeThread(thread), i, bar);
		}).reduce(async (p, next) => {
			let result = await p;
			if (result)
				results.push(result);
			
			return next();
		}, Promise.resolve());

		results.push(last);*/

		let k = 0;
		let results = await Promise.all(threads.map((thread, i) => limit(async () => {
			let result = await this.scrapeThread(thread); // TODO: Would need to parse the `message` count.
			bar.update(++k);
			return {
				info: thread,
				posts: result
			};
		})));

		// Stop bar
		bar.stop();

		// Log duration
		let duration = Math.ceil((new Date().getTime() - start.getTime()) / 1000);
		console.log(`Scraped ${threads.length} thread${threads.length == 1 ? "" : "s"} in ${duration} second${duration == 1 ? "" : "s"}.`);
		return results;
	},
	setSessionToken(token) {
		sessionToken = token;
		authenticated = true;
	},
	getSessionToken() {
		return sessionToken;
	}
};