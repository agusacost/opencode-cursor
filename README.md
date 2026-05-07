# opencode-cursor

Plugin de **OpenCode** que te permite usar tu suscripción de **Cursor** dentro de OpenCode mediante:

- OAuth PKCE (login en navegador)
- Descubrimiento de modelos (gRPC/HTTP2 contra `api2.cursor.sh`)
- Proxy local **OpenAI-compatible** (`/v1/chat/completions`, streaming SSE)
- Enrutamiento de herramientas: rechaza tools nativas de Cursor y expone las tools de OpenCode vía MCP

## Requisitos

- **OpenCode**
- **Bun** (runtime de plugins de OpenCode)
- **Node.js >= 18** (solo para el bridge HTTP/2 `h2-bridge.mjs`)
- Suscripción activa de **Cursor**

## Instalación en OpenCode

En `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cursor"],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

Nota: el bloque `provider.cursor` mínimo es necesario para que OpenCode no descarte el provider.

## Login

```bash
opencode auth login --provider cursor
```

OpenCode abrirá el navegador para completar el login con Cursor. Los tokens los gestiona OpenCode.

## Variables de entorno

- `CURSOR_API_URL`: default `https://api2.cursor.sh`
- `CURSOR_REFRESH_URL`: default `https://api2.cursor.sh/auth/exchange_user_api_key`

## Arquitectura

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

## Desarrollo local

```bash
npm install
npx tsc -p tsconfig.json --noEmit
```

Para ejecutar el smoke test necesitás Bun instalado:

```bash
bun test test/smoke.ts
```

