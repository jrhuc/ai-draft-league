/* Runs inside the replay iframe before replay-embed.js (the site CSP bars
 * inline scripts there, so this lives at /replay-frame.js).
 *
 * replay-embed.js injects its dependencies without async=false, so they
 * execute in download-completion order. When graphics.js lands before
 * battledata.js (Firefox, reliably), its load-time IIFE finds no window.Dex
 * and skips prefixing BattleEffects urls, leaving bare filenames that resolve
 * against this site instead of play.pokemonshowdown.com — every move effect
 * 404s. Pre-seeding the two prefixes the IIFE reads makes either order safe;
 * battledata.js later replaces the stub with the real Dex. */
window.Dex = {
  resourcePrefix: "https://play.pokemonshowdown.com/",
  fxPrefix: "https://play.pokemonshowdown.com/fx/",
};

new ResizeObserver(function () {
  var style = getComputedStyle(document.body);
  var height =
    document.body.getBoundingClientRect().height +
    parseFloat(style.marginTop) +
    parseFloat(style.marginBottom);
  parent.postMessage({ type: "ps-height", height: height }, "*");
}).observe(document.body);
