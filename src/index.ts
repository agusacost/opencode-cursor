import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { getCursorModels, clearModelCache, type CursorModel } from "./models.js";
import { startProxy } from "./proxy.js";

const CURSOR_PROVIDER_ID = "cursor";

export const CursorAuthPlugin: Plugin = async (input: PluginInput) => {
  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (!auth || auth.type !== "api") return {};

        const apiKey = auth.key;
        if (!apiKey) return {};

        const models = await getCursorModels(apiKey);

        const port = await startProxy(async () => apiKey, models);

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
          type: "api",
          label: "Cursor API Key",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Pegá tu Cursor API Key",
              placeholder: "cursor_...",
              validate(value: string) {
                if (!value || !value.trim()) return "La API key no puede estar vacía";
                return undefined;
              },
            },
          ],
          async authorize(inputs?: Record<string, string>) {
            const key = inputs?.key?.trim() ?? "";
            if (!key) return { type: "failed" as const };
            return { type: "success" as const, key };
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

export { clearModelCache };

export const CursorPlugin = CursorAuthPlugin;

// OpenCode plugin entrypoint expects a `server` export (PluginModule.server).
export const server = CursorAuthPlugin;
export default CursorAuthPlugin;
