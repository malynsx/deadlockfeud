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

On the home screen (or in the host panel's **Game** section before a game starts) click **Edit questions**. You can change the wording, answers and points, add, copy, reorder or delete questions, and switch individual questions out of the game. **Save questions** keeps them in this browser; answers are sorted highest first automatically.

Questions are saved per browser, so use **Export** to download a `.json` copy and **Import** to load it on another computer. **Reset to defaults** goes back to the built-in set in `questions.js`.

## Heroes

Players pick a Deadlock hero in the lobby (each hero once per room). The team tickets show the hero of whoever is answering, plus small portraits of the whole team. When someone gets an answer, their portrait switches to the gloat card and they say a kill line; a strike shows the critical card and a low-health line. Voices only play on the big screen.

Within a team, players answer in turn, Family Feud style. In the face-off it's whoever buzzed.

Portraits, quotes and voice lines come from [deadlock.wiki](https://deadlock.wiki) and belong to Valve. To refresh them when new heroes come out, run `python tools/scrape.py` and then `python tools/compress.py` (needs Pillow).

## Good to know

- The host's browser is the game server: if the host closes or refreshes the tab, the game ends.
- Messages go through free public relays: two MQTT brokers (HiveMQ, EMQX) and five Nostr relays on the normal HTTPS port. Everyone connects to every relay they can reach, so networks or VPNs that block unusual ports still work. Anyone who guesses a room code could listen in on the public board, so don't put anything private in questions or team names.
- Unrevealed answers are never sent to players, so nobody can peek.
