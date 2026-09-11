const { handleApi, sendJson } = require("../server");

function normalizedApiUrl(request) {
  const host = request.headers?.host || "localhost";
  const url = new URL(request.url || "/api", `https://${host}`);
  const rewrittenPath = request.query?.path;

  if ((url.pathname === "/api" || url.pathname === "/api/index") && rewrittenPath) {
    const segments = Array.isArray(rewrittenPath) ? rewrittenPath : String(rewrittenPath).split("/");
    url.pathname = `/api/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }

  url.searchParams.delete("path");
  return url;
}

module.exports = async function handler(request, response) {
  try {
    const handled = await handleApi(request, response, normalizedApiUrl(request));
    if (handled === false && !response.writableEnded) {
      sendJson(response, 404, { error: "API route not found" });
    }
  } catch (error) {
    if (!response.writableEnded) {
      sendJson(response, error.statusCode || 500, { error: error.message || "Unexpected server error" });
    }
  }
};

module.exports.normalizedApiUrl = normalizedApiUrl;
