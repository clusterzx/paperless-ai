# Foundry Local 2.2.1

Paperless-AI's **Foundry Local** preset connects to an externally hosted,
OpenAI-compatible REST endpoint. The Foundry Local SDK runs on the inference
host, not inside Paperless-AI. Upgrade that host to `foundry-local-sdk@2.2.1`;
there is no Foundry Local dependency in Paperless-AI's `package.json` to bump.
The Foundry CLI has a separate version and is not the SDK package.

## Host the model

Use Node.js 20 or later and the [official JavaScript web-server sample](https://github.com/microsoft/Foundry-Local/tree/main/samples/js/web-server-example)
as the starting point for a separate host application. Pin its
`foundry-local-sdk` dependency to `2.2.1`. Obtain packages through your
organization's approved package source where required.

The SDK 2.x hosting sequence is:

1. Create the manager with `FoundryLocalManager.create({ appName: 'paperless-ai', webServiceUrls: 'http://127.0.0.1:5764' })`.
2. Call `await manager.downloadAndRegisterEps()` to register the execution providers for the host hardware.
3. Select an available model with `await manager.catalog.getModel(alias)`, download it with `await model.download()`, and load it with `await model.load()`.
4. Call `manager.startWebService()` to expose the OpenAI-compatible endpoint.
5. Keep the host process and model running while Paperless-AI uses them. The official sample stops the service after its demonstration request; adapt that lifecycle for a persistent host.

Use the listening URL with `/v1` appended as the Paperless-AI base URL. With
the configuration above, that is `http://127.0.0.1:5764/v1`.
Use the loaded `model.id` from the SDK sample, or the alias of the loaded
model. Do not copy an arbitrary cached variant ID: that variant must be loaded
by the process serving the endpoint.

When shutting down the host, stop its web service and unload the model.
Execution-provider registration enables the runtime to use available hardware;
actual performance depends on the selected model, provider, and device.

## Configure Paperless-AI

Select **Foundry Local** in setup or settings:

| Field | Value |
| --- | --- |
| Base URL | The reachable listening URL followed by `/v1` |
| API key | Leave blank to use Paperless-AI's dummy key |
| Model | The loaded model's ID or alias |

For environment-based configuration, use `AI_PROVIDER=foundry-local` and the
existing `CUSTOM_BASE_URL`, `CUSTOM_API_KEY`, and `CUSTOM_MODEL` variables.
Paperless-AI does not download models or start Foundry Local automatically.

## Docker networking

When Paperless-AI runs in Docker and Foundry Local runs on the host, use
`http://host.docker.internal:5764/v1`. A service bound only to host loopback
may not be reachable from the container: configure `webServiceUrls` with an
appropriate host interface and allow the container through the host firewall.
Never enter a wildcard bind address such as `0.0.0.0` as the client base URL.

Docker Desktop normally provides `host.docker.internal`. On Linux Docker
Engine, add `host.docker.internal:host-gateway` to the Paperless-AI service's
Compose `extra_hosts`, or use a reachable host address.

The dummy API key does not authenticate requests. Do not expose the inference
endpoint to untrusted networks; restrict access to the Paperless-AI host or
container network.

Before starting a scan, verify `/v1/models` and a chat completion from the
Paperless-AI network, then use setup/settings to test the connection. If
requests fail, check that the model is loaded and the host process is still
running before changing Paperless-AI settings.

See also the [official SDK integration guide](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-integrate-with-inference-sdks)
and the [SDK package page](https://www.npmjs.com/package/foundry-local-sdk).
