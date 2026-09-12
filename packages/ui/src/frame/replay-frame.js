/** graphics.js may load before battledata.js; both resource prefixes must already exist. */
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

var liveLines = [];
var following = false;
window.addEventListener("message", function (event) {
  if (event.source !== parent) return;
  var data = event.data;
  if (!data || data.type !== "ps-live") return;
  var battle = window.Replays && window.Replays.battle;
  if (!battle) return;
  if (!liveLines.length) window.Replays.changeSetting("sound", "off");
  var lines = data.raw.trimEnd().split("\n");
  var reset =
    !liveLines.length ||
    liveLines.some(function (line, index) {
      return lines[index] !== line;
    });
  var changed = reset || lines.length !== liveLines.length;
  if (reset) battle.setQueue(lines);
  else
    lines.slice(liveLines.length).forEach(function (line) {
      battle.add(line);
    });
  if (data.follow) {
    if (reset || !following) battle.seekTurn(Infinity);
    if (changed || !following) battle.play();
  } else if (following) battle.pause();
  following = data.follow;
  liveLines = lines;
});

window.addEventListener("load", function () {
  setTimeout(function () {
    parent.postMessage({ type: "ps-ready" }, "*");
  }, 0);
});
