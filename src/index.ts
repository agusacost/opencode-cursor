import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import { getCursorModels, type CursorModel } from "./models";
import { startProxy } from "./proxy";

const CURSOR_PROVIDER_ID = "cursor";

export const CursorAuthPlugin: Plugin = async (input: PluginInput) => {
  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") return {};

        let accessToken = auth.access as string | undefined;
        const expires = auth.expires as number | undefined;
        const refresh = auth.refresh as string | undefined;
        if (!refresh) return {};

        if (!accessToken || (typeof expires === "number" && expires < Date.now())) {
          const refreshed = await refreshCursorToken(refresh);
          await input.client.auth.set({
            path: { id: CURSOR_PROVIDER_ID },
            body: {
              type: "oauth",
              refresh: refreshed.refresh,
              access: refreshed.access,
              expires: refreshed.expires,
            },
          });
          accessToken = refreshed.access;
        }

        const models = await getCursorModels(accessToken);

        const port = await startProxy(async () => {
          const currentAuth = await getAuth();
          if (!currentAuth || currentAuth.type !== "oauth") {
            throw new Error("Cursor auth not configured");
          }
          const curAccess = currentAuth.access as string | undefined;
          const curRefresh = currentAuth.refresh as string | undefined;
          const curExpires = currentAuth.expires as number | undefined;
          if (!curRefresh) throw new Error("Cursor refresh token missing");

          if (!curAccess || (typeof curExpires === "number" && curExpires < Date.now())) {
            const refreshed = await refreshCursorToken(curRefresh);
            await input.client.auth.set({
              path: { id: CURSOR_PROVIDER_ID },
              body: {
                type: "oauth",
                refresh: refreshed.refresh,
                access: refreshed.access,
                expires: refreshed.expires,
              },
            });
            return refreshed.access;
          }
          return curAccess;
        }, models);

        if (provider) {
          (provider as any).models = buildCursorProviderModels(models, port);
        }

        return {
          baseURL: `http://localhost:${port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, unknown>)["authorization"];
                delete (init.headers as Record<string, unknown>)["Authorization"];
              }
            }
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login con Cursor",
          async authorize() {
            const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
            return {
              url: loginUrl,
              instructions:
                "Completá el login en tu navegador. Esta ventana se cerrará automáticamente.",
              method: "auto" as const,
              async callback() {
                const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
                return {
                  type: "success" as const,
                  refresh: refreshToken,
                  access: accessToken,
                  expires: getTokenExpiry(accessToken),
                };
              },
            };
          },
        },
      ],
    },
  };
};

function buildCursorProviderModels(models: CursorModel[], port: number): Record<string, unknown> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        id: model.id,
        providerID: CURSOR_PROVIDER_ID,
        api: {
          id: model.id,
          url: `http://localhost:${port}/v1`,
          npm: "@ai-sdk/openai-compatible",
        },
        name: model.name,
        capabilities: {
          temperature: true,
          reasoning: model.reasoning,
          attachment: false,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        limit: {
          context: model.contextWindow,
          output: model.maxTokens,
        },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    ]),
  );
}

export const CursorPlugin = CursorAuthPlugin;

// OpenCode plugin entrypoint expects a `server` export (PluginModule.server).
export const server = CursorAuthPlugin;
export default CursorAuthPlugin;

