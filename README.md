# CodeStory

A local code reader with source-linked explanations, clickable functions, and Story Mode. Single files and Projects beta accept plain-text source in any programming language. Local syntax inspection varies by language; AI scans provide deeper explanations using the selected source.

## Run locally

1. Install [Node.js](https://nodejs.org/) version **22.13 or later**.
2. Download this repository using **Code → Download ZIP** and extract it, or clone it:

   ```sh
   git clone https://github.com/Coltigo/CodeStory.git
   cd CodeStory
   ```

3. In the CodeStory folder, run:

   ```sh
   npm start
   ```

Open **http://127.0.0.1:4173** if your browser does not open automatically. The built browser and server files are included; installing dependencies is unnecessary just to run the app.

Stop the background server with:

```sh
npm stop
```

Closing the browser does not stop the server. To run in the foreground instead, use `node runtime/server.mjs --open` and press **Control-C** to stop it.

On macOS, **Start CodeStory.app** and **Stop CodeStory.app** also work when kept in this folder. If macOS blocks a launcher, use the Terminal commands above. The `.command` launchers are another macOS option. Windows and Linux users can use the same npm commands.

## Connect your own AI

Open **AI Connections** and choose an eligible **ChatGPT account** or your own **OpenAI, Claude, or Gemini API key**. Available models and account access depend on the provider. API-key connections use the provider's API quota and billing, separately from a consumer chat subscription.

Choose a model, add your code, and review the file-sharing notice before starting an AI scan. Local inspection does not need an AI connection. AI scans send the selected source and analysis context to the chosen provider after confirmation. Explanations can be inaccurate; check the original source links. CodeStory does not execute uploaded code.

Each installation starts without a connected account. ChatGPT authorization is stored locally in `.local/accounts.json`, which Git ignores. API keys remain in the running server's memory and are removed when it stops. Do not share `.local/`, account files, logs, environment files, or credentials. Uploaded code and completed guides are temporary tab/server-memory state rather than saved project history.

## Local AI

1. Install [Ollama](https://ollama.com/) or [LM Studio](https://lmstudio.ai/) and download a text model that supports JSON-schema output. Initial installation and model downloads require internet access; a downloaded model can run offline.
2. For Ollama, **Start server** in CodeStory can start an installed runner. You can also start it separately. Ollama uses `http://127.0.0.1:11434/v1`. In LM Studio, load your model and start the server in the **Developer** tab; its usual address is `http://127.0.0.1:1234/v1`.
3. In **AI Connections → Local AI**, select the runner, check its address, click **Find models**, choose the installed model, and click **Connect local model**.
4. Click **Save local preferences**, or connect to save the runner, address and model. Enable **Start Ollama and reconnect** to restore the connection when CodeStory next starts. The selected Ollama model loads automatically when a scan requests it. No model download is started by CodeStory.
5. Return to a file or Projects, review the local sharing notice, and scan. The same reading levels, Story Mode, caching, cancellation and project scan workflow apply.

CodeStory contacts only a validated HTTP loopback address and never falls back to a cloud provider. Choose downloaded models and disable cloud features in the runner for offline use; the runner controls its own upstream connections. Cloud-tagged models are omitted from discovery. This connection does not use a ChatGPT or API-plan allowance. Local preferences are saved in `.local/local-preferences.json`; this file contains only runner, address, model and automatic-start settings. API keys and ChatGPT credentials are not stored there. Automatic lifecycle control currently uses Ollama; LM Studio server lifecycle remains manual. Local servers requiring API authentication are not supported by this connector.

**Shut down local server** stops only an Ollama child process started by this CodeStory session. Existing servers are reused and left running. Normal CodeStory shutdown (`npm stop`, Control-C or Stop CodeStory.app) also stops its managed runner. An automatic-start preference reconnects on the next launch, not immediately after a manual shutdown.

Generation can take several minutes. Elapsed time is shown while waiting for a complete, validated guide; project progress counts processed files rather than estimating model completion. If output is incomplete or the server rejects the schema, use a smaller file, increase the runner's context/output capacity, or choose another structured-output model. An invalid or incomplete guide is not cached. Automated tests use simulated local responses; hardware performance and actual model explanation quality require testing on your own machine.

## Projects beta

Open **Projects · Beta → Load processed demo** for a complete included project guide without an AI connection or inference requests. The demo uses prewritten, source-reviewed explanations and clearly labels its results. Explore both reading levels, Story Mode, source links and completion checks.

To scan your own code, choose a folder, multiple source files, or **Try a small project**. Review included files and select a starting point before scanning. Limits are **20 selected files**, **80 KB per file**, and **240 KB total**. Projects and the single-file workspace stay separate. Binary files, common generated/dependency folders, and potentially sensitive files are excluded. Unknown text formats remain readable and can be scanned with AI. Each project request can include source from all selected readable files, so review the selection and request count before consenting. Local cross-file function links currently cover direct Python imports; other language references and unresolved calls stay distinct from verified calls.

Project results identify starting files, called helpers, referenced source and additional context. File guides expose declared inputs and return expressions with source links. Changing the starting point preserves existing guides and reading checks; changing files or the import root invalidates them. Each failed file has a retry action that opens a new consent notice; completed guides stay available after a failure or cancellation.

Small example folders are in `examples/projects/weather-workshop/` and `examples/projects/password-quality/`. Choose one example folder with **Import root → Project folder** and start at `main.py`. The password example uses demonstration text and basic educational checks; do not upload real passwords.

## Development

```sh
npm ci
npm run check
npm run build
```

Tests use simulated provider responses. The build updates `dist/app.js` and `runtime/server.mjs`. Restart the server after a backend rebuild.

Required dependency notices are in `THIRD_PARTY_NOTICES.txt` and `src/csharp/LICENSE`.
