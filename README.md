# monkey-scripts
> Scripts for Tampermonkey.

Current scripts:

- `chatgpt-auto-temporary-chat.user.js`: automatically enables temporary chat on ChatGPT.
- `github-pr-patch-cleaner.user.js`: cleans noisy sections from GitHub PR `.patch` pages and raw patch URLs, replacing lockfiles and binary/non-text diffs with compact placeholders for easier LLM copy/paste.
- `hackernews-reader-mode.user.js`: rewrites Hacker News item pages as a single clean article so iOS Safari Reader Mode can read the thread aloud, flattening nested comments with spoken parent attribution (e.g. "bob replying to alice").
- `slack-emoji-for-github.user.js`: caches Slack custom emoji names and adds GitHub textarea autocomplete.
- `vimium-lite.user.js`: a single-file recreation of [Vimium](https://github.com/philc/vimium) in the spirit of a content script — keyboard-driven link hints (`f`/`F`/`yf`), scrolling (`h/j/k/l`, `gg`/`G`, `d`/`u`, `zH`/`zL`), find (`/`, `n`/`N`), history (`H`/`L`), URL hierarchy (`gu`/`gU`), local marks (`m{a-z}`/`` `{a-z}` ``), insert mode (`i`/`Esc`), count prefixes (e.g. `5j`), and a `?` help dialog. Tab and bookmark commands are intentionally omitted since they need extension APIs a userscript can't reach.
- `x-video-downloader.user.js`: adds a Save button to videos in X/Twitter posts and downloads the highest-bitrate MP4 variant.
- `youtube-bilibili-custom-speed.user.js`: applies preferred playback speeds on YouTube and Bilibili.
- `youtube-enhancements.user.js`: removes YouTube thumbnails, auto-unmutes video pages, and keeps iOS background playback alive.
