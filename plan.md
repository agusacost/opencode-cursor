# Prompt para Agente: Implementación de Plugin `opencode-cursor` en TypeScript

---

## 🧠 Contexto y Objetivo

Necesito que planifiques e implementes un **paquete npm en TypeScript** llamado `opencode-cursor` que integre las modelos de **Cursor** dentro de **OpenCode** usando el sistema de plugins nativo de OpenCode.

El objetivo es poder usar los modelos de Cursor (claude-sonnet, gpt, etc.) directamente desde el TUI/CLI de OpenCode, aprovechando una suscripción activa de Cursor, sin depender de API keys adicionales.

---

## 📚 Contexto Técnico Esencial

### Cómo funciona el sistema de plugins de OpenCode

OpenCode tiene un sistema de plugins oficial basado en módulos JS/TS. Los plugins:
- Se instalan desde npm agregándolos al array `"plugin"` en `~/.config/opencode/opencode.json`
- O se colocan como archivos `.js`/`.ts` en `.opencode/plugins/` (proyecto) o `~/.config/opencode/plugins/` (global)
- Se instalan automáticamente con **Bun** al iniciar OpenCode
- Se cachean en `~/.cache/opencode/node_modules/`
- Los tipos se importan desde `@opencode-ai/plugin`

**Estructura básica de un plugin:**
```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MiPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    // hooks y tools aquí
  }
}
```

**Eventos disponibles más relevantes:**
- `session.created`, `session.idle`, `session.status`
- `tool.execute.before`, `tool.execute.after`
- `shell.env`
- `message.updated`, `message.part.updated`
- `tui.toast.show`, `tui.prompt.append`, `tui.command.execute`

**Custom tools:**
```typescript
import { tool } from "@opencode-ai/plugin"

tool({
  description: "descripción",
  args: { param: tool.schema.string() },
  async execute(args, context) { return "resultado" }
})
```

### La limitación clave de los providers

> **IMPORTANTE**: OpenCode **no permite registrar providers customizados** desde plugins. Los providers deben estar configurados en `opencode.json` usando un paquete AI SDK (como `@ai-sdk/openai-compatible`). Esta limitación es la razón por la cual el patrón de **proxy local** es el enfoque correcto.

### El patrón de arquitectura correcto (aprendizaje de implementaciones existentes)

La solución técnica consiste en tres capas:

```
OpenCode → @ai-sdk/openai-compatible → Proxy local HTTP (tu plugin) → Cursor API (gRPC/HTTP2)
```

1. **OpenCode** hace POST a `/v1/chat/completions` en el proxy local (ej: `http://127.0.0.1:32124/v1`)
2. **El proxy** (iniciado por el plugin) traduce esa request al protocolo de Cursor
3. **Cursor API** en `api2.cursor.sh` responde via gRPC/HTTP2
4. El proxy convierte la respuesta al formato SSE de OpenAI y la devuelve a OpenCode

### Investigación de implementaciones existentes

Se encontraron **tres implementaciones comunitarias** activas con distintos enfoques:

#### 1. `opencode-cursor` by Nomadcxx (`@rama_nigg/open-cursor`)
- **Enfoque**: Proxy HTTP que delega en `cursor-agent` CLI (herramienta oficial de Cursor)
- **Auth**: OAuth vía `cursor-agent login`
- **Pros**: Usa herramienta oficial, más estable ante cambios de API
- **Contras**: Requiere `cursor-agent` instalado; spawn por request (lento); serialización compleja
- **Arquitectura**: `OpenCode → @ai-sdk/openai-compatible → Proxy :32124 → spawn cursor-agent → Cursor API`

#### 2. `opencode-cursor-oauth` by ephraimduncan
- **Enfoque**: Proxy HTTP que habla **directamente con la API gRPC de Cursor** sin depender de cursor-agent
- **Auth**: OAuth PKCE browser-based; tokens en `~/.local/share/opencode/auth.json`
- **Pros**: Sin dependencias externas de CLI; token refresh automático; más rápido
- **Contras**: Requiere implementar el protocolo gRPC/HTTP2 manualmente; usa un proceso Node hijo para HTTP/2 (Bun tiene soporte inconsistente)
- **Arquitectura**: `OpenCode → Bun.serve proxy → Node child process h2-bridge.mjs → api2.cursor.sh gRPC`
- **Tool routing**: Rechaza las tools nativas de Cursor (filesystem/shell) y las expone via MCP de OpenCode

#### 3. `cursor-opencode-auth` by Infiland
- **Enfoque**: Monorepo con `opencode-plugin-cursor` + `cursor-openai-bridge` como paquetes separados
- **Auth**: Cursor CLI (`agent login`)
- **Estructura**: `packages/opencode-plugin-cursor/` + `packages/cursor-openai-bridge/`
- **Tools custom**: `cursor_cli_patch` (worktree diff), `cursor_cloud_*` (Cursor Cloud Agents)
- **Nota importante**: Documenta explícitamente que OpenCode no soporta `provider()` en plugin API

---

## 🏗️ Arquitectura a Implementar

Implementar una versión mejorada basada en el **enfoque de ephraimduncan** (sin cursor-agent como dependencia), con las mejoras de seguridad y organización de Infiland.

### Estructura del proyecto

```
opencode-cursor/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                    # Entry point del plugin
│   ├── plugin.ts                   # Plugin principal (export CursorPlugin)
│   ├── proxy/
│   │   ├── server.ts               # Bun HTTP server en puerto configurable
│   │   ├── handler.ts              # Handler de /v1/chat/completions
│   │   └── transform.ts            # OpenAI ↔ Cursor format converters
│   ├── auth/
│   │   ├── oauth.ts                # PKCE OAuth flow con Cursor
│   │   ├── tokens.ts               # Storage/refresh de tokens
│   │   └── keychain.ts             # Almacenamiento seguro de credenciales
│   ├── cursor/
│   │   ├── client.ts               # Cliente HTTP/2 para api2.cursor.sh
│   │   ├── models.ts               # Model discovery desde API de Cursor
│   │   └── h2-bridge.ts            # Node.js child process para HTTP/2
│   ├── tools/
│   │   └── status.ts               # Tool cursor_status para diagnóstico
│   └── config.ts                   # Configuración y variables de entorno
├── scripts/
│   ├── install.ts                  # Post-install: patch opencode.json
│   └── h2-bridge.mjs               # Bridge HTTP/2 ejecutado como proceso Node
└── test/
    ├── smoke.ts
    └── proxy.test.ts
```

### Configuración final del usuario (opencode.json)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cursor"],
  "provider": {
    "cursor": {
      "name": "Cursor",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:32124/v1"
      },
      "models": {}
    }
  }
}
```

El plugin debe **auto-poblar el bloque `models`** al iniciarse consultando la API de Cursor.

---

## 📋 Requisitos Funcionales

### RF-01: Autenticación OAuth PKCE
- Implementar flujo OAuth con PKCE contra `https://cursor.com`
- Abrir browser automáticamente para login
- Almacenar tokens de forma segura (ver sección de seguridad)
- Refresh automático de access token antes de expirar
- Comando `/cursor-login` accesible desde el TUI de OpenCode via `tui.command.execute`

### RF-02: Proxy OpenAI-compatible local
- Servidor HTTP en `127.0.0.1:32124` (configurable via `CURSOR_PROXY_PORT`)
- Solo escuchar en loopback (NUNCA en 0.0.0.0)
- Implementar `POST /v1/chat/completions` con soporte streaming SSE
- Implementar `GET /v1/models` para model discovery
- Health check en `GET /health`

### RF-03: Traducción de protocolos
- Convertir OpenAI chat format → Cursor gRPC request format
- Manejar streaming SSE de respuesta de Cursor → SSE de OpenAI
- Soporte para `tool_calls` bidireccional
- **Rechazar** las tools nativas de Cursor (readArgs, shellArgs, etc.) y redirigirlas a las tools de OpenCode via MCP

### RF-04: Model discovery automático
- Al iniciar el plugin, consultar la API de Cursor para obtener modelos disponibles
- Actualizar automáticamente el bloque `models` en `opencode.json`
- Controlable via env `CURSOR_DISCOVER_MODELS=true` (default)
- Si falla, usar lista hardcodeada de fallback (no romper el startup)

### RF-05: Custom tool de diagnóstico
- Tool `cursor_status` que retorna: estado de auth, proxy activo, modelos disponibles, versión del plugin

---

## 🔒 Requisitos de Seguridad (CRÍTICOS)

### SEC-01: Almacenamiento de tokens
- **NO** almacenar tokens en texto plano en disco directamente
- Usar el keychain del sistema operativo como primera opción:
  - macOS: `security` CLI (Keychain)
  - Linux: `secret-tool` (libsecret) o `kwallet`
  - Windows: Windows Credential Manager via `dpapi`
- Fallback: archivo `~/.local/share/opencode-cursor/auth.json` con permisos `chmod 600`
- **NUNCA** loguear tokens en ningún nivel de log

### SEC-02: Proxy solo loopback
- El servidor HTTP **SIEMPRE** debe bindear a `127.0.0.1`, nunca a `0.0.0.0`
- Agregar header `X-Proxy-Auth` con token interno random generado al inicio para evitar que otros procesos locales hagan requests al proxy
- Validar ese header en cada request

### SEC-03: Validación de inputs
- Sanitizar y validar todos los campos del body de `/v1/chat/completions` antes de enviarlos a Cursor
- Limitar el tamaño máximo del body (default 10MB)
- No reenviar headers arbitrarios del cliente hacia la API de Cursor

### SEC-04: Secrets en env vars
- Si el usuario provee `CURSOR_API_KEY` como variable de entorno, usarla en lugar del flow OAuth
- Nunca exponer la API key o tokens en logs, errores o respuestas del proxy
- Redactar tokens en cualquier output de debug

### SEC-05: Protección de archivos de config
- El script de instalación debe verificar permisos antes de escribir en `opencode.json`
- No sobrescribir configuración existente del usuario sin hacer backup primero
- Escribir cambios atómicamente (write to temp file, then rename)

### SEC-06: PKCE correctness
- Usar `crypto.randomBytes(32)` para el code_verifier (no Math.random)
- code_challenge method: S256
- state parameter aleatorio para prevenir CSRF en el callback OAuth

---

## ⚙️ Requisitos Técnicos de Implementación

### Tech Stack
- **Runtime**: Bun (compatible con Node 18+)
- **Lenguaje**: TypeScript estricto (`"strict": true` en tsconfig)
- **HTTP server**: `Bun.serve()` para el proxy
- **HTTP/2 bridge**: proceso hijo Node.js (`h2-bridge.mjs`) para comunicación con Cursor API
- **Plugin types**: `@opencode-ai/plugin`
- **AI SDK**: `@ai-sdk/openai-compatible` (declarado como peerDependency, lo gestiona OpenCode)
- **Testing**: Bun test runner

### Configuración TypeScript
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

### package.json
```json
{
  "name": "opencode-cursor",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### Manejo de errores
- Todos los errores deben ser instancias de clases Error con mensajes descriptivos
- El proxy debe retornar errores en formato OpenAI error response (`{ error: { message, type, code } }`)
- Si el proxy no puede iniciar (puerto ocupado), intentar puertos alternativos (32124-32130) y loguear cuál se usó
- Si la autenticación falla, mostrar toast informativo al usuario via `tui.toast.show`

---

## 🔄 Flujo de Inicialización del Plugin

```
1. Plugin cargado por OpenCode (Bun runtime)
2. Verificar si hay tokens válidos almacenados
3. Si no hay tokens → mostrar toast "Ejecuta /cursor-login para autenticarte"
4. Si hay tokens → verificar que no estén expirados, refrescar si es necesario
5. Iniciar proxy HTTP en loopback
6. Si CURSOR_DISCOVER_MODELS=true → consultar modelos y actualizar opencode.json
7. Registrar tool cursor_status
8. Registrar handler para comando /cursor-login
9. Loguear "Plugin cursor iniciado correctamente" via client.app.log()
```

---

## 🧪 Testing

Implementar los siguientes tests:

1. **smoke.ts**: Verifica que el proxy inicia, acepta una request mínima y devuelve respuesta con formato correcto
2. **proxy.test.ts**: Tests unitarios para `transform.ts` — conversión OpenAI→Cursor y Cursor→OpenAI
3. **auth.test.ts**: Tests del flow PKCE (mocked), verificación de token refresh
4. **security.test.ts**: Verificar que proxy solo escucha en loopback, que el header de auth interno funciona, que inputs malformados son rechazados

---

## 📖 README mínimo esperado

El README debe incluir:
1. Prerequisitos (OpenCode, Bun/Node, suscripción Cursor activa)
2. Instalación en 3 pasos (editar opencode.json, reiniciar, ejecutar /cursor-login)
3. Configuración de `opencode.json` con bloque completo
4. Variables de entorno disponibles (`CURSOR_PROXY_PORT`, `CURSOR_DISCOVER_MODELS`, `CURSOR_API_KEY`)
5. Arquitectura en ASCII art (igual al ejemplo de ephraimduncan)
6. Sección de seguridad explicando el almacenamiento de tokens
7. Troubleshooting común

---

## ⚠️ Consideraciones Adicionales para el Agente

1. **Cursor API no es pública**: La integración depende de ingeniería inversa del protocolo de `cursor-agent` y `api2.cursor.sh`. Revisar el código fuente de los tres proyectos mencionados como referencia, especialmente el `h2-bridge.mjs` de `ephraimduncan/opencode-cursor`.

2. **OpenCode no expone `provider()` en plugins**: No intentes registrar el provider programáticamente. La única forma es mediante `opencode.json` + `@ai-sdk/openai-compatible` apuntando al proxy local.

3. **Bun HTTP/2**: Bun tiene soporte inconsistente de `node:http2` contra la API de Cursor. Usar un proceso hijo Node.js para el bridge HTTP/2 es el patrón probado y correcto.

4. **Model names**: Los model IDs en Cursor no siguen siempre el formato OpenAI. El model discovery debe normalizar los nombres y crear aliases donde sea necesario.

5. **ToS de Cursor**: Esta integración usa la suscripción del usuario de forma similar a como `cursor-agent` lo haría. El usuario es responsable de cumplir los términos de servicio de Cursor.

6. **Iteración incremental**: Implementar en este orden:
   - Fase 1: Proxy básico con token hardcodeado (smoke test)
   - Fase 2: OAuth PKCE completo
   - Fase 3: Model discovery
   - Fase 4: Tool routing (rechazar cursor native tools, exponer via MCP)
   - Fase 5: Keychain integration
   - Fase 6: Tests y documentación

---

## 📂 Referencias Clave

- Documentación oficial plugins: https://opencode.ai/docs/plugins/
- Documentación server API: https://opencode.ai/docs/server/
- Tipos del plugin: `@opencode-ai/plugin` en npm
- Referencia `ephraimduncan/opencode-cursor`: arquitectura gRPC directa + tool routing
- Referencia `Nomadcxx/opencode-cursor` (`@rama_nigg/open-cursor`): model discovery + config patching
- Referencia `Infiland/cursor-opencode-auth`: monorepo structure + cloud tools