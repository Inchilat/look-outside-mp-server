// Builds the host app as a single executable for the current platform (Node "Single Executable Application").
//   npm install && npm run build:app   ->   build/look-outside-mp-host-<platform>-<arch>[.exe]
// Needs Node 22 (the executable is a copy of the node binary running this script with the app injected).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "../..");
const out = path.join(root, "build");
const generated = path.join(__dirname, "generated");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const exeName = `look-outside-mp-host-${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

// The executable contains Node.js and the ws library: their licenses travel with it
function writeNotices() {
    const nodeDir = path.dirname(process.execPath);
    const nodeLicense = [path.join(nodeDir, "LICENSE"), path.join(nodeDir, "..", "LICENSE")].find(f => fs.existsSync(f));
    const wsPkg = JSON.parse(fs.readFileSync(require.resolve("ws/package.json"), "utf8"));
    const parts = [
        "Look Outside MP Host - third-party software included in this executable",
        "",
        "=".repeat(78),
        `Node.js ${process.version} - https://nodejs.org/`,
        "=".repeat(78),
        nodeLicense ? fs.readFileSync(nodeLicense, "utf8") : `See https://github.com/nodejs/node/blob/${process.version}/LICENSE`,
        "=".repeat(78),
        `ws ${wsPkg.version} - https://github.com/websockets/ws`,
        "=".repeat(78),
        fs.readFileSync(path.join(path.dirname(require.resolve("ws/package.json")), "LICENSE"), "utf8"),
    ];
    if (!nodeLicense) console.warn("Node.js LICENSE file not found next to the node binary: notices point to the online copy");
    fs.writeFileSync(path.join(out, "THIRD-PARTY-NOTICES.txt"), parts.join("\n"));
    console.log("notices:", path.relative(root, path.join(out, "THIRD-PARTY-NOTICES.txt")));
}

function run(cmd, args) {
    console.log("$", cmd, args.join(" "));
    execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && cmd === "npx" });
}

(async () => {
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(generated, { recursive: true });
    // 1) embed the dashboard and the version
    fs.writeFileSync(
        path.join(generated, "assets.js"),
        "module.exports = " +
            JSON.stringify({
                dashboard: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8"),
                version: pkg.version,
            }) +
            ";\n"
    );
    try {
        // 2) one JavaScript file with everything (ws included)
        const bundle = path.join(out, "host-app.js");
        await esbuild.build({
            entryPoints: [path.join(__dirname, "main.js")],
            bundle: true,
            platform: "node",
            target: "node22",
            format: "cjs",
            outfile: bundle,
            external: ["bufferutil", "utf-8-validate"], // optional native speedups of ws
            logLevel: "warning",
        });
        console.log("bundle:", path.relative(root, bundle));
        if (process.argv.includes("--bundle-only")) return;

        // 3) single executable: node binary + injected bundle
        const blob = path.join(out, "sea-prep.blob");
        const seaConfig = path.join(out, "sea-config.json");
        fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
        run(process.execPath, ["--experimental-sea-config", seaConfig]);
        const exe = path.join(out, exeName);
        fs.copyFileSync(process.execPath, exe);
        fs.chmodSync(exe, 0o755);
        if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
        const postject = [
            "postject",
            exe,
            "NODE_SEA_BLOB",
            blob,
            "--sentinel-fuse",
            "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
            ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
        ];
        run("npx", postject);
        if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);
        fs.unlinkSync(blob);
        fs.unlinkSync(seaConfig);
        console.log("executable:", path.relative(root, exe));
        writeNotices();
    } finally {
        fs.rmSync(generated, { recursive: true, force: true });
    }
})().catch(e => {
    console.error(e);
    process.exit(1);
});
