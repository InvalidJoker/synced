export default {
	async fetch(request, env, ctx): Promise<Response> {
		const githubMavenUrl = `https://maven.pkg.github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/`;
		const githubToken = env.GITHUB_TOKEN;

		const url = new URL(request.url);
		let path = url.pathname;

		if (path.startsWith('/')) {
			path = path.slice(1);
		}
		if (!isAllowedPath(env, path)) {
			return new Response(`Invalid request (bad path)`, {
				status: 404,
				headers: {
					'Access-Control-Allow-Origin': '*',
				},
			});
		}
		console.log(`Request for path: ${path}`);
		if (!isAllowedExtension(env, path)) {
			return new Response(`Invalid request (bad extension)`, {
				status: 404,
				headers: {
					'Access-Control-Allow-Origin': '*',
				},
			});
		}
		console.log(`Request for path with allowed extension: ${path}`);
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, OPTIONS',
					'Access-Control-Allow-Headers': 'Accept, HEAD',
				},
			});
		} else if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response(`Method not allowed`, {
				status: 405,
				headers: {
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		const targetUrl = `${githubMavenUrl}${path}`;

		const cache = caches.default;
		const cacheTtl = 60 * 5;
		const cacheKey = new Request(targetUrl, { method: 'GET' });

		const cachedResponse = await cache.match(cacheKey);
		if (cachedResponse) {
			return request.method === 'HEAD' ? stripBody(cachedResponse) : cachedResponse.clone();
		}

		console.log(`Fetching from GitHub Packages: ${targetUrl}`);
		if (!githubToken) {
			console.error('GitHub token is not set');
			return new Response(`Internal server error`, { status: 500 });
		}

		const newRequest = new Request(targetUrl, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${githubToken}`,
				Accept: request.headers.get('Accept') || 'application/octet-stream',
				'User-Agent': 'Cloudflare-Worker-Maven-Proxy',
				'Access-Control-Allow-Origin': '*',
			},
		});

		try {
			const response = await fetch(newRequest);
			console.log(`Response status from GitHub Packages: ${response.status}`);

			if (!response.ok) {
				console.warn('Failed to fetch from GitHub Packages', response);
				const fail = new Response(`Failed to fetch from GitHub Packages: ${response.statusText}`, {
					status: response.status,
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Cache-Control': `public, max-age=${cacheTtl}`,
					},
				});
				ctx.waitUntil(cache.put(cacheKey, fail.clone()));
				return fail;
			}

			const cacheResponse = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});

			cacheResponse.headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
			cacheResponse.headers.set('Access-Control-Allow-Origin', '*');

			ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
			console.log(`Cached response for ${targetUrl} for ${cacheTtl} seconds`);

			return request.method === 'HEAD' ? stripBody(cacheResponse) : cacheResponse;
		} catch (error) {
			console.error('Internal server error', error);
			return new Response(`Internal server error`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

function stripBody(response: Response): Response {
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function isAllowedPath(env: Env, url: string): boolean {
	if (env.ALLOWED_PATHS) {
		const allowedPackages: RegExp[] = [];
		const split = env.ALLOWED_PATHS.split(',');
		for (let i = 0; i < split.length; i++) {
			allowedPackages.push(new RegExp(split[i].trim()));
		}
		if (allowedPackages.length === 0) {
			return true;
		}
		for (let i = 0; i < allowedPackages.length; i++) {
			const pkg = allowedPackages[i];
			if (pkg.test(url)) {
				return true;
			}
		}
		console.warn(`Request for path "${url}" is not allowed by ALLOWED_PATHS: ${env.ALLOWED_PATHS}`);
		return false;
	}
	return true;
}

function isAllowedExtension(env: Env, path: string): boolean {
	const allowedExtensions = env.ALLOWED_EXTENSIONS.split(',');

	for (const ext of allowedExtensions) {
		if (path.endsWith(ext)) {
			return true;
		}
	}

	return false;
}
