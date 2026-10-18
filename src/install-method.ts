import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isSea } from "node:sea";

/*
 * How the running cloudpin was installed, so upgrade advice names the command
 * that actually upgrades it (#16, #17, #98; docs/superpowers/specs/2026-10-17-installers-design.md).
 *
 * Decided from the path of the running script, both as run and with links
 * followed. Homebrew runs `bin/cloudpin`, a link into
 * `Cellar/cloudpin/<version>/libexec/...` (docs.brew.sh/Manpage, `brew --cellar`:
 * `$(brew --prefix)/Cellar`, prefix /opt/homebrew, /usr/local or
 * /home/linuxbrew/.linuxbrew; `brew shellenv` exports HOMEBREW_CELLAR). Scoop
 * keeps apps in `<root>\apps\<app>\` under $env:SCOOP (default ~\scoop) or
 * $env:SCOOP_GLOBAL (default $env:ProgramData\scoop). The JavaScript package
 * managers' global folders are below, each with its source. Anything else,
 * including `npm install --global` with Homebrew's node or Scoop's nodejs-lts,
 * a project's own node_modules and npx's cache, is npm.
 *
 * Only the environment variables cited below and each tool's defaults are read,
 * not config files: a global folder moved in .npmrc, pnpm's config.yaml,
 * .yarnrc or bunfig.toml reads as npm, the advice cloudpin gave before.
 *
 * The standalone cloudpin.exe (#96, docs/superpowers/specs/2026-10-18-winget-design.md)
 * has no script: it is decided from the exe's own path, and is "winget" in
 * winget's portable package folder or "exe" anywhere else (runningInstallMethod).
 */

export type InstallMethod = "npm" | "brew" | "scoop" | "pnpm" | "volta" | "yarn" | "bun" | "winget" | "exe";

/** The winget package identifier (packaging/winget/; the design's "winget identity"). */
const WINGET_ID = "paureis.cloudpin";
const RELEASES = "https://github.com/paureis/cloudpin/releases";
const DOWNLOAD = `download the latest cloudpin-X.Y.Z-win-x64.zip from ${RELEASES}`;

const DEFAULT_CELLARS = ["/opt/homebrew/Cellar", "/usr/local/Cellar", "/home/linuxbrew/.linuxbrew/Cellar"];

/** Where one way of installing keeps cloudpin. Entries may be unset; each is also tried with its links followed. */
interface Layout {
  method: InstallMethod;
  /** Folders that hold only cloudpin (a keg, a Scoop app, a Volta package image): any path inside counts. */
  apps?: (string | undefined)[];
  /** Global folders laid out like a project, with cloudpin's package at a path below that `pkg` matches. */
  globals?: (string | undefined)[];
  pkg?: RegExp;
  /**
   * Folders of launchers (links, scripts, exes): a `cloudpin` launcher directly inside counts when it is a file.
   * When it is a link, its target decides instead, unless the target is one of `shims` (a file name) or inside
   * one of `shimDirs`: another folder of the same install's own.
   */
  bins?: (string | undefined)[];
  shims?: string[];
  shimDirs?: (string | undefined)[];
}

// `cloudpin` with the extensions launchers get on Windows: Scoop's shims (.cmd, .ps1, .exe), pnpm's (.cmd, .ps1),
// Volta's (.cmd), Yarn's (.cmd) and Bun's (.exe plus .bunx). Elsewhere launchers have no extension.
const LAUNCHER = /^cloudpin(\.(cmd|ps1|exe|bunx))?$/;
// Yarn classic and Bun: the global folder is a plain project, so cloudpin is `<global>/node_modules/cloudpin/`.
const TOP_LEVEL = /^node_modules\/cloudpin\//;
// pnpm: `<global>/5/` (pnpm 10) or `<global>/v11/<install dir>/` (pnpm 11+), then node_modules/cloudpin or its
// folder in the virtual store, `.pnpm/cloudpin@<version>/node_modules/cloudpin` (pnpm 10 links the bins to that one).
const PNPM_PKG = /^[^/]+\/([^/]+\/)?(node_modules\/(\.pnpm\/cloudpin@[^/]+\/node_modules\/)?|\.pnpm\/cloudpin@[^/]+\/node_modules\/)cloudpin\//;
// winget: a portable package's folder is <root>\<PackageIdentifier>_<source identifier> (GetPortableProductCode in
// src/AppInstallerCLICore/Workflows/PortableFlow.cpp, github.com/microsoft/winget-cli). Paths are lowercased on Windows.
const WINGET_PKG = /^paureis\.cloudpin_[^/]+\//i;

/** The layouts to look for, in order; `get` reads an environment variable, `join` is the platform's path join. */
function layouts(
  platform: NodeJS.Platform,
  get: (key: string) => string | undefined,
  join: (...parts: string[]) => string,
): Layout[] {
  const under = (base: string | undefined, ...parts: string[]) => (base ? join(base, ...parts) : undefined);
  const windows = platform === "win32";
  const home = windows ? get("USERPROFILE") : get("HOME");
  const localAppData = windows ? get("LOCALAPPDATA") : undefined;
  const os: Layout[] = [];
  if (windows) {
    const roots = [get("SCOOP"), get("SCOOP_GLOBAL"), under(home, "scoop"), under(get("PROGRAMDATA"), "scoop")];
    // Scoop's shims are files, not links: `shim` in Scoop's lib/core.ps1 writes <root>\shims\cloudpin plus .cmd,
    // .ps1 or .exe. That is the path PATH finds, which doctor classifies.
    os.push({ method: "scoop", apps: roots.map((r) => under(r, "apps", "cloudpin")), bins: roots.map((r) => under(r, "shims")) });
    // winget's portable packages: <root>\Packages\<id>_<source>\ with a link to the exe in <root>\Links\, root
    // %LOCALAPPDATA%\Microsoft\WinGet for the user scope, %ProgramFiles%\WinGet or %ProgramFiles(x86)%\WinGet for the
    // machine (doc/specs/#182 - Support for installation of portable standalone apps.md, and doc/Settings.md for
    // the defaults; portablePackageUserRoot and portablePackageMachineRoot in winget's settings.json move them).
    const winget = [under(localAppData, "Microsoft", "WinGet"), under(get("PROGRAMFILES"), "WinGet"), under(get("PROGRAMFILES(X86)"), "WinGet")];
    os.push({ method: "winget", globals: winget.map((w) => under(w, "Packages")), pkg: WINGET_PKG, bins: winget.map((w) => under(w, "Links")) });
  } else {
    const cellars = [get("HOMEBREW_CELLAR"), ...DEFAULT_CELLARS];
    os.push({ method: "brew", apps: cellars.map((c) => under(c, "cloudpin")) });
  }

  // Volta (github.com/volta-cli/volta, unmaintained since November 2025: volta-cli/volta#2080): VOLTA_HOME, default ~/.volta, or
  // %LOCALAPPDATA%\Volta on Windows (crates/volta-core/src/layout/{unix,windows}.rs). `volta install` puts a package
  // in <home>/tools/image/packages/<name>/ (crates/volta-layout/src/v4.rs). Its shims are in <home>/bin: links to
  // volta-shim on macOS and Linux, a `volta run` .cmd plus a bash script on Windows (crates/volta-core/src/shim.rs).
  const volta = [get("VOLTA_HOME"), windows ? under(localAppData, "Volta") : under(home, ".volta")];
  // volta-shim sits wherever Volta itself was installed, so only its name counts.
  os.push({
    method: "volta",
    apps: volta.map((v) => under(v, "tools", "image", "packages", "cloudpin")),
    bins: volta.map((v) => under(v, "bin")),
    shims: ["volta-shim", "volta-shim.exe"],
  });

  // pnpm's home is PNPM_HOME, else $XDG_DATA_HOME/pnpm, else ~/Library/pnpm, ~/.local/share/pnpm or
  // %LOCALAPPDATA%\pnpm (getDataDir, pnpm11/config/reader/src/dirs.ts in github.com/pnpm/pnpm; pnpm.io/npmrc).
  // Global packages are in <home>/global/<layout>/ (resolveGlobalDirs in config/reader/src/index.ts), and the bins
  // in <home> up to pnpm 10 or <home>/bin from pnpm 11 (applyGlobalInstallSettings, getConfig/globalInstall.ts):
  // shell scripts, .cmd and .ps1 files written by cmd-shim (bins/linker/src/linkBin.ts). pnpm 11 defaults global
  // installs to the global virtual store, so the real path is in <home>/store/v11/links/, shared with projects
  // that opt in; only the path as run (the shims name <home>/global/v11/<hash>/...) tells them apart.
  const pnpm = [
    get("PNPM_HOME"),
    under(get("XDG_DATA_HOME"), "pnpm"),
    windows ? under(localAppData, "pnpm") : platform === "darwin" ? under(home, "Library", "pnpm") : under(home, ".local", "share", "pnpm"),
  ];
  // PNPM_CONFIG_GLOBAL_DIR or pnpm_config_global_dir (prefix and name in one case: getEnvKeySuffix,
  // config/reader/src/env.ts) sets globalDir, which replaces <home>/global (applyGlobalDirEnvVars in
  // getConfig/envVars.ts; resolveGlobalDirs joins the layout version onto it).
  os.push({
    method: "pnpm",
    globals: [get("PNPM_CONFIG_GLOBAL_DIR"), get("pnpm_config_global_dir"), ...pnpm.map((p) => under(p, "global"))],
    pkg: PNPM_PKG,
    bins: [...pnpm, ...pnpm.map((p) => under(p, "bin"))],
    // preferSymlinkedExecutables: a bin that is a link into the global virtual store.
    shimDirs: pnpm.map((p) => under(p, "store", "v11", "links")),
  });

  // Yarn classic (github.com/yarnpkg/yarn, frozen at 1.22): `yarn global dir` is <data>/global, data being
  // %LOCALAPPDATA%\Yarn\Data on Windows, else $XDG_DATA_HOME/yarn, else ~/.config/yarn (src/util/user-dirs.js;
  // classic.yarnpkg.com/en/docs/cli/global). Bins go to <prefix>/bin, prefix /usr/local, %LOCALAPPDATA%\Yarn or
  // ~/.yarn (getGlobalPrefix, src/cli/commands/global.js): links on macOS and Linux, cmd-shim files on Windows
  // (linkBin, src/package-linker.js). /usr/local/bin is npm's too, so there only the link's target counts.
  const yarnData = windows
    ? [under(get("LOCALAPPDATA"), "Yarn", "Data"), under(home, ".config", "yarn")]
    : [under(get("XDG_DATA_HOME"), "yarn"), under(home, ".config", "yarn")];
  os.push({
    method: "yarn",
    globals: yarnData.map((d) => under(d, "global")),
    pkg: TOP_LEVEL,
    bins: [windows ? under(localAppData, "Yarn", "bin") : undefined, under(home, ".yarn", "bin")],
  });

  // Bun (github.com/oven-sh/bun, src/install/PackageManager/PackageManagerOptions.rs open_global_dir and
  // open_global_bin_dir; bun.com/docs/runtime/bunfig): the global folder is BUN_INSTALL_GLOBAL_DIR, else
  // $BUN_INSTALL/install/global, else <$XDG_CACHE_HOME or home>/.bun/install/global; bins likewise in
  // BUN_INSTALL_BIN or .../bin: links on macOS and Linux, cloudpin.exe plus cloudpin.bunx on Windows.
  const bun = [get("BUN_INSTALL"), under(get("XDG_CACHE_HOME"), ".bun"), under(home, ".bun")];
  os.push({
    method: "bun",
    globals: [get("BUN_INSTALL_GLOBAL_DIR"), ...bun.map((b) => under(b, "install", "global"))],
    pkg: TOP_LEVEL,
    bins: [get("BUN_INSTALL_BIN"), ...bun.map((b) => under(b, "bin"))],
  });
  return os;
}

/**
 * `script` is the running script's path (process.argv[1], which Node resolves
 * but does not follow links in); `realpath` follows the links in it and in
 * each folder above, and may throw, in which case the path is used as given.
 */
export function installMethod(
  script: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  realpath: (path: string) => string,
): InstallMethod {
  if (script === "") return "npm";
  // A path and its real path, links followed, or just the path when realpath fails.
  const forms = (path: string): string[] => {
    try {
      return [path, realpath(path)];
    } catch {
      return [path];
    }
  };
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  // Windows variable names and paths are case-insensitive; copies of the environment keep `ProgramData`, `PROGRAMDATA`...
  const get = windows ? (key: string) => Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] || undefined : (key: string) => env[key] || undefined;
  const norm = windows ? (p: string) => win32.normalize(p).toLowerCase() : (p: string) => posix.normalize(p);
  // Each folder as written and as realpath reports it: ~\scoop can be a junction to another drive, and on
  // Fedora Silverblue /home is a link to /var/home.
  const dirs = (list: (string | undefined)[] = []) => list.filter((d): d is string => Boolean(d)).flatMap(forms).map(norm);
  /** The part of `p` below `dir`, with `/` separators, or null when `p` is not inside it. */
  const below = (p: string, dir: string): string | null => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return p.startsWith(prefix) ? p.slice(prefix.length).split(path.sep).join("/") : null;
  };
  const run = norm(script);
  const real = norm(forms(script).at(-1) ?? script);
  // A launcher found on the path as run is the layout's when it is a file (or can't be followed), or a link to the
  // layout's own shim; any other link leads somewhere else, and that place decides (an npm bin in a folder that is
  // also PNPM_HOME is npm's).
  const ownLauncher = (layout: Layout): boolean =>
    run === real || (layout.shims ?? []).includes(path.basename(real)) || dirs(layout.shimDirs).some((dir) => below(real, dir) !== null);
  const matches = (p: string, layout: Layout, launchers: boolean): boolean =>
    dirs(layout.apps).some((dir) => below(p, dir) !== null) ||
    dirs(layout.globals).some((dir) => layout.pkg!.test(below(p, dir) ?? "")) ||
    (launchers &&
      dirs(layout.bins).some((dir) => {
        const rest = below(p, dir);
        return rest !== null && LAUNCHER.test(rest);
      }));
  const all = layouts(platform, get, path.join);
  // Where the code really is first; then the path as run, which is all a shim or a link to a shim gives.
  for (const [p, asRun] of [[real, false], [run, true]] as const) {
    const found = all.find((layout) => matches(p, layout, !asRun || ownLauncher(layout)));
    if (found) return found.method;
  }
  // No npm-style install writes a cloudpin.exe (npm's bins are .cmd and .ps1 files, cmd-shim), so outside the
  // layouts above (Scoop's and Bun's exes) it is the standalone exe, unpacked wherever the user put it. The real
  // path decides: a cloudpin.exe link to a script is that script's install.
  if (windows && path.basename(real) === "cloudpin.exe") return "exe";
  return "npm";
}

/** What tells how the running cloudpin was installed. */
export interface Running {
  /** node:sea isSea(): true inside the standalone cloudpin.exe. */
  isSea: boolean;
  /** process.execPath: the exe in a SEA, node otherwise. */
  execPath: string;
  /** process.argv[1]: the script on Node. */
  script: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
}

/**
 * How this running cloudpin was installed. On Node, from the script's path; in
 * the standalone exe, from the exe's path (a SEA's argv[1] is the exe too, and
 * `import.meta.url` names it: nodejs.org/api/single-executable-applications.html),
 * and only "winget" or "exe", since no package manager ships that exe.
 */
export function runningInstallMethod(r: Running = current()): InstallMethod {
  if (!r.isSea) return installMethod(r.script, r.env, r.platform, r.realpath);
  return installMethod(r.execPath, r.env, r.platform, r.realpath) === "winget" ? "winget" : "exe";
}

function current(): Running {
  return {
    isSea: isSea(),
    execPath: process.execPath,
    script: process.argv[1] ?? "",
    env: process.env,
    platform: process.platform,
    realpath: (p) => realpathSync(p),
  };
}

/** The command that upgrades cloudpin installed this way (README's install line for the package managers; Bun's names @latest). */
export function upgradeCommand(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew upgrade cloudpin";
    case "scoop":
      return "scoop update cloudpin";
    case "pnpm":
      return "pnpm add --global cloudpin";
    case "volta":
      return "volta install cloudpin";
    case "yarn":
      return "yarn global add cloudpin";
    case "bun":
      // bun.com/docs/pm/cli/add doesn't say a bare name upgrades an entry already in the global package.json.
      return "bun add --global cloudpin@latest";
    case "winget":
      // learn.microsoft.com/windows/package-manager/winget/upgrade
      return `winget upgrade ${WINGET_ID}`;
    case "exe":
      return DOWNLOAD;
    case "npm":
      return "npm install --global cloudpin";
  }
}

/** How to reinstall cloudpin installed this way (Scoop has no reinstall command; the package managers' install does it). */
export function reinstallCommand(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew reinstall cloudpin";
    case "scoop":
      return "scoop uninstall cloudpin, then scoop install cloudpin";
    case "winget":
      return `winget uninstall ${WINGET_ID}, then winget install ${WINGET_ID}`;
    default:
      return upgradeCommand(method);
  }
}

/**
 * What to do when this cloudpin runs but none is on PATH: recreate the link,
 * shim or launcher, and check that the folder it lives in is on PATH (`brew
 * link`, `scoop reset` recreates shims, the package managers' install writes
 * their bins; `pnpm setup` and `volta setup` add their bin folders to PATH).
 */
export function pathFix(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew link cloudpin, and check that Homebrew's bin folder ($(brew --prefix)/bin) is on PATH";
    case "scoop":
      return "scoop reset cloudpin, and check that Scoop's shims folder is on PATH";
    case "pnpm":
      return "pnpm add --global cloudpin, and check that pnpm's bin folder (pnpm bin --global) is on PATH; pnpm setup adds it";
    case "volta":
      return "volta install cloudpin, and check that Volta's bin folder (in VOLTA_HOME) is on PATH; volta setup adds it";
    case "yarn":
      return "yarn global add cloudpin, and check that Yarn's bin folder (yarn global bin) is on PATH";
    case "bun":
      return "bun add --global cloudpin@latest, and check that Bun's bin folder (bun pm bin --global) is on PATH";
    case "winget":
      // winget adds its Links folder to PATH when it installs a portable package (doc/specs/#182 in winget-cli).
      return `winget install ${WINGET_ID}, and check that winget's Links folder (%LOCALAPPDATA%\\Microsoft\\WinGet\\Links) is on PATH; open a new terminal after installing`;
    case "exe":
      return "add the folder that holds cloudpin.exe to your PATH, then open a new terminal";
    case "npm":
      return "npm install --global cloudpin";
  }
}
