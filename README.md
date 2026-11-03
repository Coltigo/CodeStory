# CodeStory

A local code reader with source-linked explanations, clickable functions, and Story Mode. Single-file support includes Python, HTML, JavaScript, Java, C#, and SQL. Projects beta supports small Python projects.

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

## Python projects beta

Open **Projects · Beta** and choose a folder, multiple `.py` files, or **Try a small project**. Review included files and select a starting point before scanning. Limits are **20 selected files**, **80 KB per file**, and **240 KB total**. Projects and the single-file workspace stay separate.

Small example folders are in `examples/projects/weather-workshop/` and `examples/projects/password-quality/`. Choose one example folder with **Import root → Project folder** and start at `main.py`. The password example uses demonstration text and basic educational checks; do not upload real passwords.

## Development

```sh
npm ci
npm run check
npm run build
```

Tests use simulated provider responses. The build updates `dist/app.js` and `runtime/server.mjs`. Restart the server after a backend rebuild.

Required dependency notices are in `THIRD_PARTY_NOTICES.txt` and `src/csharp/LICENSE`.
