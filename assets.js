// Files the app needs at runtime. In the packaged executable they are embedded
// (host/app/generated/assets.js, written by host/app/build.js); from the sources they are read from disk.
const fs = require("fs");
const path = require("path");

let embedded = null;
try {
    embedded = require("./generated/assets.js");
} catch {
    /* running from the sources */
}

const read = rel => fs.readFileSync(path.join(__dirname, rel), "utf8");

module.exports = {
    dashboard: () => (embedded ? embedded.dashboard : read("dashboard.html")),
    version: () => (embedded ? embedded.version : JSON.parse(read("../../package.json")).version),
};
