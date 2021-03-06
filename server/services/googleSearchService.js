var Promise = require('bluebird');
var request = Promise.promisifyAll(require('request'), {multiArgs:true});

var googleSearchService = module.exports;

googleSearchService.imageSearch = function (query) {
	// supposedly this API was turned off a year ago but still seems to work :shrug:
	// there is a new API with a 100 / day limit but I couldn't get it working :fistshake:
	// notes for new api
	return request.getAsync({
		json: true,
		url: 'https://ajax.googleapis.com/ajax/services/search/images',
		qs: {
			v: '1.0',
			rsz: 8,
			safe: 'active',
			q: query
		}
	})
		.spread(function (response, body) {
			return body.responseData.results;
		})
		.map(function (image) {
			return image.unescapedUrl;
		});
};

googleSearchService.oneImage = function (query) {
	return googleSearchService.imageSearch(query)
		.then(function (images) {
			return _.sample(images);
		});
};

googleSearchService.gifSearch = function (query) {
	var options = {
		json: true,
		url: 'https://ajax.googleapis.com/ajax/services/search/images',
		qs: {
			v: '1.0',
			rsz: 8,
			safe: 'active',
			imgType: 'animated',
			start: 0,
			q: query
		}
	};

	return loadGifs();

	function loadGifs(goodImageUrls) {
		goodImageUrls = goodImageUrls || [];

		return request.getAsync(options)
			.spread(function (response, body) {
				return body.responseData.results;
			})
			.map(function (image) {
				return image.unescapedUrl;
			})
			.filter(function (image) {
				if (image.indexOf('giphy') > -1) return false;
				if (image.indexOf('ytimg') > -1) return false;
				if (image.indexOf('gifsec') > -1) return false;
				if (image.indexOf('photobucket') > -1) return false;
				if (image.indexOf('replygif') > -1) return false;
				if (image.indexOf('gifrific') > -1) return false;
				if (image.indexOf('phinzmania') > -1) return false;
				if (image.indexOf('gifsoup') > -1) return false;
				if (image.indexOf('gifwave') > -1) return false;
				if (image.indexOf('.jpg') > -1) return false;
				if (image.indexOf('.jpeg') > -1) return false;
				if (image.indexOf('.png') > -1) return false;
				return true;
			})
			.then(function (images) {
				// push all
				goodImageUrls.push.apply(goodImageUrls, images);
				goodImageUrls = _.unique(goodImageUrls);

				if (goodImageUrls.length < 8) {
					// next page
					options.qs.start = options.qs.start + 8;
					return loadGifs(goodImageUrls);
				}

				return goodImageUrls;
			});
	}
};

googleSearchService.oneGif = function (query) {
	return googleSearchService.gifSearch(query)
		.then(function (images) {
			return _.sample(images);
		});
};


var bingImageSearch;

bingImageSearch = function(msg, query, animated, faces, cb) {
	var bingApiKey, encoded_key, q, url;
	bingApiKey = process.env.HUBOT_BING_API_KEY;
	if (!bingApiKey) {
		msg.robot.logger.error("Missing environment variable HUBOT_BING_API_KEY");
		msg.send("Missing server environment variable HUBOT_BING_API_KEY");
		return;
	}
	q = {
		$format: 'json',
		Query: "'" + query + "'",
		Adult: "'Strict'"
	};
	encoded_key = new Buffer(bingApiKey + ":" + bingApiKey).toString("base64");
	url = "https://api.datamarket.azure.com/Bing/Search/Image";
	return msg.http(url).query(q).header("Authorization", "Basic " + encoded_key).get()(function(err, res, body) {
		var image, response;
		if (err) {
			if (res.statusCode === 403) {
				msg.send("Monthly Bing image quota exceeded. Please wait until tomorrow to search for more images.");
			} else {
				msg.send("Encountered an error :( " + err);
			}
			return;
		}
		response = JSON.parse(body);
		if ((response != null ? response.d : void 0) && response.d.results) {
			image = msg.random(response.d.results);
			return cb(ensureResult(image.MediaUrl, animated));
		} else {
			return msg.send("Oops. I had trouble searching '" + query + "'. Try later.");
		}
	});
};

// ---
// generated by coffee-script 1.9.2
