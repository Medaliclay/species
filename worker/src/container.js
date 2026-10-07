/**
 * Option B entry point: run BioCLIP 2 inside Cloudflare Containers (all on Cloudflare).
 * Deploy with:  npm run deploy:containers
 */
import { Container, getContainer } from "@cloudflare/containers";
import app from "./index.js";

export class BioclipContainer extends Container {
  defaultPort = 7860; // same port as the Hugging Face Space
  sleepAfter = "15m"; // stop (and stop paying) after 15 min with no requests
}

export default {
  fetch(request, env, ctx) {
    const stub = getContainer(env.BIOCLIP, "main"); // one shared instance is plenty for a class
    env.MODEL_FETCHER = {
      async fetch(req) {
        // Loading 4 GB of model + embeddings takes ~1 min on a cold start,
        // longer than the library's default 20 s wait — so wait up to 3 min.
        await stub.startAndWaitForPorts({
          ports: 7860,
          cancellationOptions: { portReadyTimeoutMS: 180_000 },
        });
        return stub.fetch(req);
      },
    };
    return app.fetch(request, env, ctx);
  },
};
