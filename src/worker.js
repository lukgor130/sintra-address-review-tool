import { onRequest as handleAoiRequest } from "../functions/api/aoi.js";

export { AoiNotesDurableObject } from "../functions/api/aoi.js";

const TERRAVIA_HOSTNAMES = new Set(["terravia.verrio.co"]);

function rewriteAssetRequest(request, pathname) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  return new Request(assetUrl, request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/aoi" || url.pathname.startsWith("/api/aoi/")) {
      return handleAoiRequest({ request, env, ctx });
    }

    if (TERRAVIA_HOSTNAMES.has(url.hostname)) {
      const pathname = url.pathname === "/" ? "/terravia/" : `/terravia${url.pathname}`;
      return env.ASSETS.fetch(rewriteAssetRequest(request, pathname));
    }

    return env.ASSETS.fetch(request);
  },
};
