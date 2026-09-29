# API server and model lifecycle

The desktop app controls model memory and the external API listener independently.
All external API formats are configured on **API server**, under Integrations
in the sidebar. Model loading remains in the model library and sessions.
Internal chat does not need the API server.

| API server | Models | Available behavior |
| --- | --- | --- |
| Stopped | Loaded | Internal chat can use the loaded models. |
| Running | None loaded | The API accepts connections and lists no loaded models; inference returns a structured error. |
| Running | Loaded | Internal chat and external API clients can use the loaded models. |

## Connect an application

1. Open **API server** in the sidebar and start the server. Starting it before
   loading a model is also supported.
2. Load the model you want to use from the model library (**Run a model**) or a
   session. The API server page has an **Open model library** action for this.
3. Choose the connection format your application speaks, **OpenAI** or
   **Anthropic**. The choice only changes the base URL and the code examples
   shown on the page.
4. Copy the base URL, API key and model ID from the same page into the external
   application, and adapt the code example.

The API port and the code examples are in collapsed sections of the page. The
port is set only there. Saving a port while the API is running restarts the API
on the new port; loaded models stay available. If the API is stopped, the new
port applies the next time it starts.

The model ID is an identifier returned by `GET /v1/models`; use it in the
request's `model` field.

The listener binds only to `127.0.0.1` on the configured API port (initially 8080).
One listener serves both protocols:

| Protocol | Endpoints | Send the key as |
| --- | --- | --- |
| OpenAI-compatible | `GET /v1/models`, `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses` | `Authorization: Bearer <key>` |
| Anthropic Messages | `POST /v1/messages` | `x-api-key: <key>` with an `anthropic-version` header |

```sh
curl http://127.0.0.1:8080/v1/models \
  -H "Authorization: Bearer <LOCAL_API_KEY>"
```

The API key remains valid while the desktop app is open, including across model
reloads and API server stop/start. It is generated again when the app starts and
is not saved to configuration. Copy it from the API server page; examples and
diagnostic output do not contain the key. Private model-process credentials are
separate.

## Load, unload and stop

- Loading or replacing a model does not start or stop the API listener.
- Unloading a model frees its process resources and removes it from the API's
  loaded-model list. The listener and its API key stay available.
- Model replacement and manual unload are rejected while that model is serving
  an active response. Finish or cancel the response first.
- Idle model unloading considers both internal chat and requests through the
  API. Keeping the API server on does not by itself keep a model loaded.
- Stopping the API server closes its connections while keeping model processes
  available to internal chat.
- Changing the configured API port takes effect on the next API server start;
  it does not require a model reload.

Model loading is manual. Requests do not automatically load models. Loading no
models is a valid API-server state; inference in that state returns HTTP 503.
The API does not implement LM Studio's `/api/v1` model-management endpoints.

## Compatibility

Desktop model processes now use private loopback ports. External applications
should use the URL and key shown on the API server page, rather than a session's
private URL or key. Anthropic and Responses clients that used the former separate
gateway on port 8081 should switch to the API server's configured port and key.
The **Diagnostics** page shows model diagnostics only; it has no server controls.

The existing `auto_start` preference loads the selected model at app startup; it
does not enable the external API. Closing or quitting the app keeps the existing
close-to-tray policy: a real exit stops both model processes and the API server.

The standalone CLI retains its existing single-process `server start/stop`
behavior. See [CLI usage](cli.md).
