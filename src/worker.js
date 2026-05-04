import { onRequest as handleAoiRequest } from "../functions/api/aoi.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/aoi" || url.pathname.startsWith("/api/aoi/")) {
      return handleAoiRequest({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
