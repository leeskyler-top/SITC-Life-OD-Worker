export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // 处理下载：GET /download/:itemId
    if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
      const itemId = url.pathname.replace('/download/', '');
      if (!itemId) {
        return jsonResponse({ status: "fail", msg: "Missing item ID" }, 400);
      }

      const authHeader = request.headers.get("Authorization");
      const userJwt = extractToken(authHeader);
      if (!userJwt) {
        return jsonResponse({ status: "fail", msg: "Unauthorized: missing JWT" }, 401);
      }

      const valid = await verifyAccessToken(userJwt, env);
      if (!valid) {
        return jsonResponse({ status: "fail", msg: "Invalid Access Token" }, 401);
      }

      const tokenData = await getTokenFromFlask(env, userJwt, request);
      if (!tokenData) {
        return jsonResponse({ status: "fail", msg: "Failed to get Microsoft Graph token" }, 500);
      }

      const graphDownloadUrl = `${tokenData.download_baseurl}${itemId}/content`;
      const fileRes = await fetch(graphDownloadUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });

      if (!fileRes.ok) {
        let errorJson;
        try {
          errorJson = await fileRes.json();
        } catch {
          errorJson = { message: "Unknown error" };
        }
        return jsonResponse({
          status: "fail",
          msg: "Download failed",
          error: errorJson
        }, fileRes.status);
      }

      const filteredHeaders = new Headers();
      for (const [key, value] of fileRes.headers.entries()) {
        if (['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag'].includes(key.toLowerCase())) {
          filteredHeaders.set(key, value);
        }
      }
      addCorsHeaders(filteredHeaders);

      return new Response(fileRes.body, {
        status: 200,
        headers: filteredHeaders
      });
    }

    // 处理分片上传开启会话：POST /upload-session
    if (request.method === 'POST' && url.pathname === '/upload-session') {
      const authHeader = request.headers.get("Authorization");
      const userJwt = extractToken(authHeader);
      if (!userJwt) {
        return jsonResponse({ status: "fail", msg: "Unauthorized: missing JWT" }, 401);
      }

      const valid = await verifyAccessToken(userJwt, env);
      if (!valid) {
        return jsonResponse({ status: "fail", msg: "Invalid Access Token"}, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ status: "fail", msg: "Invalid JSON" }, 400);
      }

      const { file_name, file_size } = body;
      if (!file_name || !file_size) {
        return jsonResponse({ status: "fail", msg: "Missing file_name or file_size" }, 400);
      }

      const tokenData = await getTokenFromFlask(env, userJwt, request);
      if (!tokenData) {
        return jsonResponse({ status: "fail", msg: "Failed to get Microsoft Graph token" }, 500);
      }

      const fullName = `${Date.now()}_${file_name}`;
      const sessionUrl = `${tokenData.upload_baseurl}${encodeURIComponent(fullName)}:/createUploadSession`;

      const sessionRes = await fetch(sessionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          item: {
            '@microsoft.graph.conflictBehavior': 'rename',
            name: fullName
          }
        })
      });

      if (!sessionRes.ok) {
        const error = await sessionRes.text();
        return jsonResponse({ status: "fail", msg: "Failed to create upload session", detail: error }, 500);
      }

      const sessionData = await sessionRes.json();

      return jsonResponse({
        status: "success",
        msg: "Upload session created",
        data: {
          uploadUrl: sessionData.uploadUrl,
          expirationDateTime: sessionData.expirationDateTime,
          fileId: sessionData.id || null
        }
      });
    }

    // 处理分片上传：POST /upload-chunk
    if (request.method === 'POST' && url.pathname === '/upload-chunk') {
      const authHeader = request.headers.get("Authorization");
      const userJwt = extractToken(authHeader);
      if (!userJwt) {
        return jsonResponse({ status: "fail", msg: "Unauthorized" }, 401);
      }

      const valid = await verifyAccessToken(userJwt, env);
      if (!valid) {
        return jsonResponse({ status: "fail", msg: "Invalid Access Token" }, 401);
      }

      // 获取 Range、uploadUrl 等信息
      const contentRange = request.headers.get('X-Content-Range');
      const uploadUrl = request.headers.get('X-Upload-Url');
      const contentLength = request.headers.get('Content-Length');

      if (!uploadUrl || !contentRange || !contentLength) {
        return jsonResponse({ status: "fail", msg: "Missing headers" }, 400);
      }

      const chunk = await request.arrayBuffer(); // 小于 1MB 安全

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': contentLength,
          'Content-Range': contentRange
        },
        body: chunk
      });

      const status = res.status;
      if (status !== 200 && status !== 201 && status !== 202) {
        let error;
        try {
          error = await res.text();
        } catch { error = "Upload failed"; }

        return jsonResponse({ status: "fail", msg: "Upload chunk failed", detail: error }, status);
      }

      return jsonResponse({ status: "success", msg: "Chunk uploaded", graph_status: status });
    }

    // 处理上传：POST /upload
    if (request.method === 'POST' && url.pathname === '/upload') {
      const authHeader = request.headers.get("Authorization");
      const userJwt = extractToken(authHeader);
      if (!userJwt) {
        return jsonResponse({ status: "fail", msg: "Unauthorized: missing JWT" }, 401);
      }

      const valid = await verifyAccessToken(userJwt, env);
      if (!valid) {
        return jsonResponse({ status: "fail", msg: "Invalid Access Token" }, 401);
      }

      let formData;
      try {
        formData = await request.formData();
      } catch {
        return jsonResponse({ status: "fail", msg: "Invalid form data" }, 400);
      }

      const file = formData.get("image_url");
      if (!(file instanceof File)) {
        return jsonResponse({ status: "fail", msg: "Invalid file" }, 400);
      }
      if (!file.type.startsWith("image/")) {
        return jsonResponse({ status: "fail", msg: "Only image files are allowed" }, 415);
      }

      const tokenData = await getTokenFromFlask(env, userJwt, request);
      if (!tokenData) {
        return jsonResponse({ status: "fail", msg: "Failed to get Microsoft Graph token" }, 500);
      }

      const fileName = `${Date.now()}_${file.name}`;
      const uploadSessionUrl = `${tokenData.upload_baseurl}${encodeURIComponent(fileName)}:/createUploadSession`;

      const sessionRes = await fetch(uploadSessionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          item: {
            '@microsoft.graph.conflictBehavior': 'rename',
            name: fileName
          }
        })
      });

      if (!sessionRes.ok) {
        return jsonResponse({ status: "fail", msg: "Failed to create upload session" }, 500);
      }

      const sessionData = await sessionRes.json();
      const uploadUrl = sessionData.uploadUrl;

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': file.size,
          'Content-Range': `bytes 0-${file.size - 1}/${file.size}`
        },
        body: file
      });

      if (!(putRes.status === 200 || putRes.status === 201)) {
        return jsonResponse({ status: "fail", msg: "Upload failed" }, 500);
      }

      const uploadedData = await putRes.json();

      const requestUrl = new URL(request.url);
      const baseUrl = env.PUBLIC_BASE_URL || `${requestUrl.protocol}//${requestUrl.host}`;
      const publicUrl = `${baseUrl}/download/${uploadedData.id}`;

      return jsonResponse({
        status: "success",
        msg: "Upload successful",
        data: { url: publicUrl }
      });
    }

    // 其他方法
    return jsonResponse({ status: "fail", msg: "Method Not Allowed" }, 405);
  }
};

// 提取 Bearer Token
function extractToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.replace("Bearer ", "");
}

// ✅ 验证 Access Token 是否有效
async function verifyAccessToken(userJwt, env) {
  const checkRes = await fetch(`${env.FLASK_BACKEND_BASE}/user/my`, {
    headers: { Authorization: `Bearer ${userJwt}` }
  });
  return checkRes.status === 200;
}

// 🔐 获取 access_token（含缓存）
async function getTokenFromFlask(env, userJwt, request) {
  const now = Date.now();
  if (getTokenFromFlask.tokenCache && now < getTokenFromFlask.tokenCache.expired_at) {
    return getTokenFromFlask.tokenCache;
  }

  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const signature  = await generateSignature(clientIp, env.CLOUDFLARE_HMAC_SECRET)
  const res = await fetch(env.FLASK_BACKEND_BASE + "/microsoft-graph/auth/callback", {
    headers: {
      Authorization: `Bearer ${userJwt}`,
      "X-Original-IP": clientIp,
      "X-Cloudflare-Signature": signature
    }
  });

  if (!res.ok) return null;

  const json = await res.json();
  getTokenFromFlask.tokenCache = json.data;
  return getTokenFromFlask.tokenCache;
}

async function generateSignature(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}


// ✅ 统一 JSON 格式响应 + CORS
function jsonResponse(obj, status = 200) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...corsHeaders()
  });
  return new Response(JSON.stringify(obj), {
    status,
    headers
  });
}

// 🌐 添加通用 CORS 头
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Upload-Url, X-Content-Range'
  };
}

// 添加 CORS 头到已存在 Header 对象中
function addCorsHeaders(headers) {
  const cors = corsHeaders();
  for (const key in cors) {
    headers.set(key, cors[key]);
  }
}
