const uploadSessionMap = new Map();

function detectMimeFromMagicBytes(bytes) {
	const hex = Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
	if (hex.startsWith('FFD8FF')) return 'image/jpeg';
	if (hex.startsWith('89504E47')) return 'image/png';
	if (hex.startsWith('47494638')) return 'image/gif';
	if (hex.startsWith('424D')) return 'image/bmp';
	if (hex.startsWith('52494646')) return 'image/webp';
	return 'application/octet-stream';
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		// 清理过期的 upload sessions
		const now = Date.now();
		for (const [key, session] of uploadSessionMap.entries()) {
			if (new Date(session.expirationDateTime).getTime() < now) {
				uploadSessionMap.delete(key);
			}
		}

		const routeHandlers = {
			GET: {
				'/download/': handleDownload
			},
			POST: {
				'/upload-session': handleUploadSession,
				'/upload-chunk': handleUploadChunk,
				'/upload': handleUpload
			}
		};

		const methodRoutes = routeHandlers[request.method];
		if (methodRoutes) {
			for (const route in methodRoutes) {
				if (url.pathname.startsWith(route)) {
					return await methodRoutes[route](request, env, url);
				}
			}
		}

		return jsonResponse({ status: 'fail', msg: 'Method Not Allowed' }, 405);
	}
};

async function authenticate(request, env) {
	const authHeader = request.headers.get('Authorization');
	const userJwt = extractToken(authHeader);
	if (!userJwt) return [null, jsonResponse({ status: 'fail', msg: 'Unauthorized: missing JWT' }, 401)];

	const valid = await verifyAccessToken(userJwt, env);
	if (!valid) return [null, jsonResponse({ status: 'fail', msg: 'Invalid Access Token' }, 401)];

	return [userJwt, null];
}

async function handleDownload(request, env, url) {
	const itemId = url.pathname.replace('/download/', '');
	if (!itemId) return jsonResponse({ status: 'fail', msg: 'Missing item ID' }, 400);

	const [userJwt, errorResponse] = await authenticate(request, env);
	if (errorResponse) return errorResponse;

	const tokenData = await getTokenFromFlask(env, userJwt, request);
	if (!tokenData) return jsonResponse({ status: 'fail', msg: 'Failed to get Microsoft Graph token' }, 500);

	const fileRes = await fetch(`${tokenData.download_baseurl}${itemId}/content`, {
		headers: { Authorization: `Bearer ${tokenData.access_token}` }
	});

	if (!fileRes.ok) {
		let errorJson = await safeJson(fileRes);
		return jsonResponse({ status: 'fail', msg: 'Download failed', error: errorJson }, fileRes.status);
	}

	const headers = new Headers();
	for (const [key, value] of fileRes.headers.entries()) {
		if ([
			'content-type',
			'content-length',
			'content-disposition',
			'last-modified',
			'etag'
		].includes(key.toLowerCase())) {
			headers.set(key, value);
		}
	}
	addCorsHeaders(headers);
	return new Response(fileRes.body, { status: 200, headers });
}

async function handleUploadSession(request, env) {
	const [userJwt, errorResponse] = await authenticate(request, env);
	if (errorResponse) return errorResponse;

	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ status: 'fail', msg: 'Invalid JSON' }, 400);
	}

	const { file_name, file_size } = body;
	if (!file_name || !file_size) return jsonResponse({ status: 'fail', msg: 'Missing file_name or file_size' }, 400);

	const lower = file_name.toLowerCase();
	if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png') && !lower.endsWith('.gif') && !lower.endsWith('.bmp') && !lower.endsWith('.webp')) {
		return jsonResponse({ status: 'fail', msg: 'Only image file extensions are allowed' }, 415);
	}

	const tokenData = await getTokenFromFlask(env, userJwt, request);
	if (!tokenData) return jsonResponse({ status: 'fail', msg: 'Failed to get Microsoft Graph token' }, 500);

	const fullName = `${Date.now()}_${file_name}`;
	const sessionRes = await fetch(`${tokenData.upload_baseurl}${encodeURIComponent(fullName)}:/createUploadSession`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${tokenData.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: fullName } })
	});

	if (!sessionRes.ok) {
		const error = await sessionRes.text();
		return jsonResponse({ status: 'fail', msg: 'Failed to create upload session', detail: error }, 500);
	}

	const sessionData = await sessionRes.json();
	const uploadId = sessionData.id || crypto.randomUUID();
	const guid = new URL(sessionData.uploadUrl).searchParams.get('guid') || crypto.randomUUID();

	uploadSessionMap.set(`${uploadId}:${guid}`, {
		uploadUrl: sessionData.uploadUrl,
		expirationDateTime: sessionData.expirationDateTime,
		validated: false
	});

	return jsonResponse({
		status: 'success',
		msg: 'Upload session created',
		data: { uploadId, guid, expirationDateTime: sessionData.expirationDateTime }
	});
}

async function handleUploadChunk(request, env) {
	const [userJwt, errorResponse] = await authenticate(request, env);
	if (errorResponse) return errorResponse;

	const uploadId = request.headers.get('X-Upload-Id');
	const guid = request.headers.get('X-Upload-Guid');
	const contentRange = request.headers.get('X-Content-Range');
	const contentLength = request.headers.get('Content-Length');
	if (!uploadId || !guid || !contentRange || !contentLength) {
		return jsonResponse({ status: 'fail', msg: 'Missing headers' }, 400);
	}

	const key = `${uploadId}:${guid}`;
	const session = uploadSessionMap.get(key);
	if (!session) {
		return jsonResponse({ status: 'fail', msg: 'Upload session not found or expired' }, 404);
	}

	const chunk = new Uint8Array(await request.arrayBuffer());

	if (!session.validated && contentRange.startsWith('bytes 0-')) {
		const mime = detectMimeFromMagicBytes(chunk);
		if (!mime.startsWith('image/')) {
			return jsonResponse({ status: 'fail', msg: `Invalid file type: ${mime}` }, 415);
		}
		session.validated = true;
		uploadSessionMap.set(key, session);
	}

	const res = await fetch(session.uploadUrl, {
		method: 'PUT',
		headers: {
			'Content-Length': contentLength,
			'Content-Range': contentRange
		},
		body: chunk
	});

	const status = res.status;
	if (![200, 201, 202].includes(status)) {
		let error = await safeText(res);
		return jsonResponse({ status: 'fail', msg: 'Upload chunk failed', detail: error }, status);
	}

	if ([200, 201].includes(status)) {
		// 上传完成，提取返回的文件 id 构造下载链接
		const uploadedData = await res.json();
		const baseUrl = env.PUBLIC_BASE_URL || `${new URL(request.url).origin}`;
		const publicUrl = `${baseUrl}/download/${uploadedData.id}`;

		return jsonResponse({
			status: 'success',
			msg: 'Upload complete',
			data: {
				graph_status: status,
				url: publicUrl
			}
		});
	} else if (status === 202) {
		// 分片还未完成
		return jsonResponse({ status: 'success', msg: 'Chunk uploaded', graph_status: status });
	} else {
		const error = await safeText(res);
		return jsonResponse({ status: 'fail', msg: 'Upload chunk failed', detail: error }, status);
	}
}

async function handleUpload(request, env) {
	const [userJwt, errorResponse] = await authenticate(request, env);
	if (errorResponse) return errorResponse;

	let formData;
	try {
		formData = await request.formData();
	} catch {
		return jsonResponse({ status: 'fail', msg: 'Invalid form data' }, 400);
	}

	const file = formData.get('image_url');
	if (!(file instanceof File)) {
		return jsonResponse({ status: 'fail', msg: 'Missing file' }, 400);
	}

	const buffer = new Uint8Array(await file.arrayBuffer());
	const mime = detectMimeFromMagicBytes(buffer);
	if (!mime.startsWith('image/')) {
		return jsonResponse({ status: 'fail', msg: `Invalid image type: ${mime}` }, 415);
	}

	const tokenData = await getTokenFromFlask(env, userJwt, request);
	if (!tokenData) return jsonResponse({ status: 'fail', msg: 'Failed to get Microsoft Graph token' }, 500);

	const fileName = `${Date.now()}_${file.name}`;
	const sessionRes = await fetch(`${tokenData.upload_baseurl}${encodeURIComponent(fileName)}:/createUploadSession`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${tokenData.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName } })
	});

	if (!sessionRes.ok) return jsonResponse({ status: 'fail', msg: 'Failed to create upload session' }, 500);

	const sessionData = await sessionRes.json();
	const uploadUrl = sessionData.uploadUrl;
	const putRes = await fetch(uploadUrl, {
		method: 'PUT',
		headers: {
			'Content-Length': file.size,
			'Content-Range': `bytes 0-${file.size - 1}/${file.size}`
		},
		body: buffer
	});

	if (![200, 201].includes(putRes.status)) {
		return jsonResponse({ status: 'fail', msg: 'Upload failed' }, 500);
	}

	const uploadedData = await putRes.json();
	const baseUrl = env.PUBLIC_BASE_URL || `${new URL(request.url).origin}`;
	const publicUrl = `${baseUrl}/download/${uploadedData.id}`;

	return jsonResponse({ status: 'success', msg: 'Upload successful', data: { url: publicUrl } });
}


function extractToken(authHeader) {
	return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

async function verifyAccessToken(userJwt, env) {
	const checkRes = await fetch(`${env.FLASK_BACKEND_BASE}/user/my`, {
		headers: { Authorization: `Bearer ${userJwt}` }
	});
	return checkRes.status === 200;
}

async function getTokenFromFlask(env, userJwt, request) {
	const now = Date.now();
	if (getTokenFromFlask.tokenCache && now < getTokenFromFlask.tokenCache.expired_at) {
		return getTokenFromFlask.tokenCache;
	}

	const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
	const signature = await generateSignature(clientIp, env.CLOUDFLARE_HMAC_SECRET);

	const res = await fetch(`${env.FLASK_BACKEND_BASE}/microsoft-graph/auth/callback`, {
		headers: {
			Authorization: `Bearer ${userJwt}`,
			'X-Original-IP': clientIp,
			'X-Cloudflare-Signature': signature
		}
	});

	if (!res.ok) return null;
	const json = await res.json();
	getTokenFromFlask.tokenCache = json.data;
	return getTokenFromFlask.tokenCache;
}

async function generateSignature(ip, secret) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {
		name: 'HMAC', hash: 'SHA-256'
	}, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
	return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: new Headers({ 'Content-Type': 'application/json', ...corsHeaders() })
	});
}

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Upload-Url, X-Content-Range, X-Upload-Id, X-Upload-Guid'
	};
}

function addCorsHeaders(headers) {
	const cors = corsHeaders();
	for (const key in cors) headers.set(key, cors[key]);
}

async function safeJson(res) {
	try {
		return await res.json();
	} catch {
		return { message: 'Unknown error' };
	}
}

async function safeText(res) {
	try {
		return await res.text();
	} catch {
		return 'Upload failed';
	}
}
