# Pi extensions

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Copilot context budget

`extensions/copilot-context.ts` sets a local compaction budget for physical GitHub Copilot models. It fetches the signed-in account's model catalog using Pi's existing Copilot credentials and reads the default and long-context pricing boundaries.

| Command | Effect |
| --- | --- |
| `/copilot-context default` | Set Pi's local context window to the smaller of the live default-tier prompt boundary and Pi's model window. |
| `/copilot-context long` | Restore the model window from Pi's catalog. |
| `/copilot-context status` | Show the selected mode and live default/long boundaries. |
| `/copilot-context refresh` | Fetch the catalog again and reapply the default budget if selected. |

With no argument, the command opens a selector. The choice is saved on the current session branch and reapplied when resuming or switching supported Copilot models. Successful catalog responses are cached in memory for five minutes; `default` and `refresh` force a fresh fetch. The extension adds no persistent status-bar entry.

### Install

Requires Pi with extension support and a configured GitHub Copilot provider. Tested with Pi 1.5.2 on macOS; other platforms have not been tested. Clone this repository and copy the extension into Pi's global extensions directory:

```sh
git clone https://github.com/supreeth20/pi-extensions.git
cd pi-extensions
mkdir -p ~/.pi/agent/extensions
cp extensions/copilot-context.ts ~/.pi/agent/extensions/
```

Run `/reload` in Pi or restart it. For Windows, copy `extensions/copilot-context.ts` to `%USERPROFILE%\.pi\agent\extensions\` and reload Pi. Updates to this repository do not automatically update an installed copy.

### Important limitations

- This changes **Pi's local compaction threshold**, not a Copilot SDK context tier or an HTTP tier selector. It does not replace Pi's HTTP provider or tool loop.
- It does **not guarantee a price tier**. Pi uses provider usage and estimates to decide when to compact; a large prompt or tool result may cross the boundary. Pricing and tier selection remain Copilot's responsibility.
- Automatic compaction must be enabled for the budget to trigger it. Pi's default 16,384-token reserve causes threshold compaction above 255,616 tokens when the local window is 272,000, unless settings override it.
- `long` restores Pi's catalog window; it does not force the live long-context boundary. The live boundary is informational in `status` and `refresh`.
- A live catalog response without a supported default/long tier, an auth failure, or a fetch failure cannot establish a default budget; the extension warns and does not silently substitute Pi's catalog pricing boundary.
- Requests use the configured Copilot endpoint and Pi's resolved credentials. The extension does not persist tokens or catalog responses, and refuses redirects. The catalog cache is unrelated to prompt caching.

### Test

With Node.js 22.6 or newer (the tests use Node's built-in TypeScript stripping):

```sh
node --experimental-strip-types --test tests/*.test.mjs
```

Tests use mocked provider responses and do not send prompts or make paid API calls.
