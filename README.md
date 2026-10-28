# Deadlock Feud

A Family Feud-style game show for Deadlock. One person hosts on a big screen; everyone else joins on their phone with a 4-letter room code and buzzes in. Static site, no server of your own.

## Put it online with GitHub Pages (free)

1. Create a new **public** repository on GitHub (e.g. `deadlockfeud`).
2. Upload these four files to the root: `index.html`, `style.css`, `game.js`, `questions.js`.
3. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. After a minute your site is live at `https://<your-username>.github.io/deadlockfeud/`.

## Running a game

1. Open the site on the screen everyone can see and click **Host a game**. Players scan the QR code on screen (or type the 4-letter code) and pick a name. Teams are balanced automatically.
2. Optional but easiest: open **Run it from your phone** in the host panel and scan that QR with your own phone. Your phone becomes the remote with the answer key, and the big screen hides its controls. Don't let players scan this one, it shows the answers.
3. Follow the **Next step** card. It always shows the one or two buttons you need: open buzzers, pick who plays, strike, steal result, next question.
4. Reveal answers from the **Answer key** (or keys 1 to 8). Mis-click? **Undo** (U) steps back.
5. Rounds 4 to 6 score double, 7 and up triple.

Keys on the host screen: 1 to 8 reveal, X strike, B buzzers, N next step, U undo, H hide controls.

## Editing questions

Open `questions.js`. Each entry is a question plus `[answer, points]` pairs (max 8). The points shipped here are estimates. For the real Family Feud feel, ask 30–50 people and use their actual answers.

## Good to know

- The host's browser is the game server: if the host closes or refreshes the tab, the game ends.
- Messages go through free public relays: two MQTT brokers (HiveMQ, EMQX) and five Nostr relays on the normal HTTPS port. Everyone connects to every relay they can reach, so networks or VPNs that block unusual ports still work. Anyone who guesses a room code could listen in on the public board, so don't put anything private in questions or team names.
- Unrevealed answers are never sent to players, so nobody can peek.
