# Deploying The Campaign Site

This app is now deployable as a Node web service.

## What Must Be Set On The Host

- `OPENROUTER_API_KEY`: your OpenRouter API key
- `OPENROUTER_MODEL`: optional, defaults to `openai/gpt-4o-mini`
- `ELEVENLABS_API_KEY`: optional, enables AI narrator audio
- `ELEVENLABS_VOICE_NAME`: optional, defaults to `Jonathan Livingston`
- `ELEVENLABS_VOICE_ID`: optional, use this instead of voice name when you have the exact voice ID
- `NODE_ENV`: `production`

Do not put API keys in `index.html` or commit them to Git.

## Render Deployment

1. Put this `fog-click-site` folder in a GitHub repository.
2. In Render, create a new Blueprint or Web Service from that repository.
3. If using the included `render.yaml`, Render will create a Node web service.
4. Add `OPENROUTER_API_KEY` in Render's Environment settings.
5. Deploy.

Render gives the app a public `onrender.com` URL. Send that URL to friends.

## Current Multiplayer Limitation

Multiplayer rooms are stored in server memory. That works while the server process stays running, but rooms reset if the host restarts or sleeps. For a public beta, this is enough. For long campaigns, add a database later.
